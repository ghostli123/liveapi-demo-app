import asyncio
import collections
import time
from typing import Dict, Optional
from websocket_handler import WebsocketHandler
from absl import logging
import google.genai.chats


class SessionBaseModel:
    def __init__(
        self,
        session_id: str,
        ws_host: str,
        websocket_handler: WebsocketHandler | None = None,
        fr_session: google.genai.chats.AsyncChat | None = None,
        fr_error: str = "",
    ):
        self.session_id: str = session_id
        self.ws_host: str = ws_host

        self.websocket_handler: WebsocketHandler | None = websocket_handler
        self.fr_session: google.genai.chats.AsyncChat | None = fr_session
        # Why fr_session is None, reported when the frontend asks for it.
        self.fr_error: str = fr_error
        # Removes the record if no WebSocket arrives; see main.py.
        self.expiry_task: asyncio.Task | None = None
        # Function declarations (JSON) for the simulator, and whether the
        # simulator's chat has been given them yet.
        self.fc_definitions: str = ""
        self.fc_definitions_sent: bool = False
        # Simulator requests take turns: the chat snapshots its history when
        # a send starts, so overlapping sends would miss each other's turn.
        self.fr_lock: asyncio.Lock = asyncio.Lock()

    async def del_session(self):
        if self.expiry_task and self.expiry_task is not asyncio.current_task():
            self.expiry_task.cancel()
        # Cleared, not deleted: a request handler may still hold this record.
        if self.websocket_handler:
            await self.websocket_handler.end_websocket()
        self.fr_session = None


class SessionAddError(Exception):
    """Raised when a session record can't be added."""


class SessionLimitError(SessionAddError):
    """Raised when adding a session would exceed the manager's limit."""


class SessionAbandonedError(SessionAddError):
    """Raised when adding a session whose browser already gave up on it."""


class SessionManager:
    """
    A thread-safe class to manage session data using an asyncio.Lock.

    This class uses a dictionary to store session-id and data pairs and ensures
    that all operations on the dictionary are atomic to prevent race conditions
    in an asynchronous environment.
    """

    # How long an abandoned session ID stays refused. It covers the
    # frontend's connect retries (4 tries of up to 15 s, 6 s of backoff).
    ABANDONED_ID_TTL_S = 120
    # Most abandoned IDs remembered; the oldest are forgotten first.
    MAX_ABANDONED_IDS = 10_000

    def __init__(self):
        """
        Initializes the SessionManager with an empty session dictionary
        and an asyncio.Lock.
        """
        self._sessions: Dict[str, SessionBaseModel] = {}
        self._lock = asyncio.Lock()
        # Session ID -> time.monotonic() when it may be added again.
        self._abandoned: collections.OrderedDict[str, float] = collections.OrderedDict()

    async def add_unless_connected(
        self, session_id: str, data: SessionBaseModel, max_sessions: int = 0
    ) -> Optional[SessionBaseModel]:
        """Stores data for session_id unless a record already exists.

        An existing pending record (e.g. from a retried control request) is
        kept so state already attached to it (such as fc_definitions) isn't
        lost, and data is not stored.

        Args:
            max_sessions: Most records to hold, pending or connected; 0 for no
                limit. Reusing session_id's own pending record doesn't count.

        Returns:
            The pending record in the manager (data if newly stored, or the
            existing pending record if one was already waiting), or None if the
            current record already has a WebSocket.

        Raises:
            SessionLimitError: Storing a new record would exceed max_sessions.
            SessionAbandonedError: remove_pending was called for session_id
                within ABANDONED_ID_TTL_S.
        """
        async with self._lock:
            current = self._sessions.get(session_id)
            if current:
                if current.websocket_handler:
                    return None
                current.ws_host = data.ws_host
                return current
            self._check_can_add_locked(session_id, max_sessions)
            self._sessions[session_id] = data
        logging.info("Session %s added", session_id)
        return data

    async def reuse_pending(
        self, session_id: str, ws_host: str
    ) -> tuple[bool, Optional[SessionBaseModel]]:
        """Updates ws_host on an existing pending record atomically.

        Returns:
            (already_connected, record):
              - (True, record) if session_id already has an active WebSocket.
              - (False, record) if a pending record exists and its ws_host was
                updated to ws_host.
              - (False, None) if no record exists for session_id.
        """
        async with self._lock:
            current = self._sessions.get(session_id)
            if current is None:
                return False, None
            if current.websocket_handler:
                return True, current
            current.ws_host = ws_host
            return False, current

    async def check_can_add(self, session_id: str, max_sessions: int) -> None:
        """Raises SessionAddError if session_id couldn't be added right now.

        A cheap early check, so a request that would be rejected skips costly
        setup; add_unless_connected checks again atomically.
        """
        async with self._lock:
            self._check_can_add_locked(session_id, max_sessions)

    def _check_can_add_locked(self, session_id: str, max_sessions: int) -> None:
        if self._abandoned.get(session_id, 0) > time.monotonic():
            raise SessionAbandonedError("The browser already gave up on this session")
        if session_id not in self._sessions and 0 < max_sessions <= len(self._sessions):
            raise SessionLimitError(f"Server is at its session limit ({max_sessions})")

    async def claim_websocket(
        self, session_id: str, record: SessionBaseModel, handler: WebsocketHandler
    ) -> bool:
        """Attaches handler to record if it is still session_id's record.

        Returns:
            False if the record was replaced or removed, or already has a
            WebSocket.
        """
        async with self._lock:
            if self._sessions.get(session_id) is not record or record.websocket_handler:
                return False
            record.websocket_handler = handler
            if record.expiry_task and record.expiry_task is not asyncio.current_task():
                record.expiry_task.cancel()
            return True

    async def release(self, session_id: str, record: SessionBaseModel) -> bool:
        """Removes record if it is still session_id's record, without ending it.

        Frees its slot under max_sessions while its handler finishes (e.g.
        closing upstream after the browser left); delete_item ends it later.

        Returns:
            Whether record was removed.
        """
        if not await self._remove(session_id, record):
            return False
        logging.info("Released session %s while it closes", session_id)
        return True

    async def remove_pending(self, session_id: str) -> bool:
        """Removes and ends session_id's record if it has no WebSocket yet.

        For a browser that gave up before connecting, so the record doesn't
        hold a max_sessions slot until it expires. A connected session ends
        when its WebSocket closes instead.

        Unless session_id is connected, it is also refused for
        ABANDONED_ID_TTL_S: a connect request still in progress (or retried)
        would otherwise add a record nobody uses after this one returns.

        Returns:
            Whether a record was removed.
        """
        async with self._lock:
            record = self._sessions.get(session_id)
            if record and record.websocket_handler:
                return False
            self._note_abandoned_locked(session_id)
            if record is None:
                return False
            del self._sessions[session_id]
        logging.info("Removed session %s before it connected", session_id)
        await record.del_session()
        return True

    def _note_abandoned_locked(self, session_id: str) -> None:
        now = time.monotonic()
        self._abandoned.pop(session_id, None)
        self._abandoned[session_id] = now + self.ABANDONED_ID_TTL_S
        # Entries share one TTL, so the oldest is first to expire.
        while (
            len(self._abandoned) > self.MAX_ABANDONED_IDS
            or next(iter(self._abandoned.values())) <= now
        ):
            self._abandoned.popitem(last=False)

    async def delete_if_pending(
        self, session_id: str, record: SessionBaseModel
    ) -> bool:
        """Removes and ends record only if it is still stored and unclaimed.

        Used by the pending-session expiry timer so a lock-contention race with
        claim_websocket() can never tear down a newly connected session.
        """
        async with self._lock:
            if (
                self._sessions.get(session_id) is not record
                or record.websocket_handler is not None
            ):
                return False
            del self._sessions[session_id]
        logging.info("Session %s never opened a WebSocket; removing it", session_id)
        await record.del_session()
        return True

    async def delete_item(self, session_id: str, record: SessionBaseModel) -> None:
        """Removes record if it is still session_id's record, and ends it.

        Checking identity keeps a handler that outlived its record from
        removing a newer one with the same ID. The record is ended either way:
        it may have been released, and ending a replaced one again is harmless.
        """
        await self._remove(session_id, record)
        logging.info("Deleting session %s", session_id)
        await record.del_session()

    async def _remove(self, session_id: str, record: SessionBaseModel) -> bool:
        async with self._lock:
            if self._sessions.get(session_id) is not record:
                return False
            del self._sessions[session_id]
            return True

    async def all_items(self) -> list[SessionBaseModel]:
        """Returns a snapshot of all sessions."""
        async with self._lock:
            return list(self._sessions.values())

    async def search_item(self, session_id: str) -> Optional[SessionBaseModel]:
        """
        Searches for a session item by its ID in a thread-safe manner.

        Args:
            session_id: The unique identifier for the session to search for.

        Returns:
            The data associated with the session_id, or None if not found.
        """
        async with self._lock:
            return self._sessions.get(session_id, None)
