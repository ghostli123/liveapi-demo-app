import asyncio
from typing import Dict, Optional
import pydantic
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
    ):
        self.session_id: str = session_id
        self.ws_host: str = ws_host

        self.websocket_handler: WebsocketHandler | None = websocket_handler
        self.fr_session: google.genai.chats.AsyncChat | None = fr_session

    async def del_session(self):
        if self.websocket_handler:
            await self.websocket_handler.end_websocket()
            del self.websocket_handler
        if self.fr_session:
            del self.fr_session


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

    async def add_item(self, session_id: str, data: SessionBaseModel) -> None:
        """
        Adds or updates a session item in a thread-safe manner.

        Args:
            session_id: The unique identifier for the session.
            data: The data to be associated with the session.
        """
        logging.info("Adding session %s", session_id)
        async with self._lock:
            self._sessions[session_id] = data
        logging.info("Session %s added", session_id)

    async def delete_item(self, session_id: str) -> None:
        """
        Deletes a session item in a thread-safe manner if it exists.

        Args:
            session_id: The unique identifier for the session to delete.
        """
        logging.info("Deleting session %s", session_id)
        session_data: SessionBaseModel | None = None
        async with self._lock:
            if session_id in self._sessions:
                session_data = self._sessions.pop(session_id)

        if session_data:
            await session_data.del_session()
            del session_data
        logging.info("Session %s deleted", session_id)

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
