import asyncio
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

    async def del_session(self):
        if self.expiry_task and self.expiry_task is not asyncio.current_task():
            self.expiry_task.cancel()
        # Cleared, not deleted: a request handler may still hold this record.
        if self.websocket_handler:
            await self.websocket_handler.end_websocket()
        self.fr_session = None


class SessionLimitError(Exception):
    """Raised when adding a session would exceed the manager's limit."""


class SessionManager:
    """
    A thread-safe class to manage session data using an asyncio.Lock.

    This class uses a dictionary to store session-id and data pairs and ensures
    that all operations on the dictionary are atomic to prevent race conditions
    in an asynchronous environment.
    """

    def __init__(self):
        """
        Initializes the SessionManager with an empty session dictionary
        and an asyncio.Lock.
        """
        self._sessions: Dict[str, SessionBaseModel] = {}
        self._lock = asyncio.Lock()

    async def add_unless_connected(
        self, session_id: str, data: SessionBaseModel, max_sessions: int = 0
    ) -> bool:
        """Stores data for session_id unless its record has a WebSocket.

        A record still waiting for its WebSocket (e.g. from a retried control
        request) is replaced and ended.

        Args:
            max_sessions: Most records to hold, pending or connected; 0 for no
                limit. Replacing session_id's own record doesn't count.

        Returns:
            False, storing nothing, if the current record has a WebSocket.

        Raises:
            SessionLimitError: Storing a new record would exceed max_sessions.
        """
        async with self._lock:
            current = self._sessions.get(session_id)
            if current and current.websocket_handler:
                return False
            if not current and 0 < max_sessions <= len(self._sessions):
                raise SessionLimitError(
                    f"Server is at its session limit ({max_sessions})"
                )
            self._sessions[session_id] = data
        logging.info("Session %s added", session_id)
        if current:
            await current.del_session()
        return True

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

        Returns:
            Whether a record was removed.
        """
        async with self._lock:
            record = self._sessions.get(session_id)
            if record is None or record.websocket_handler:
                return False
            del self._sessions[session_id]
        logging.info("Removed session %s before it connected", session_id)
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
