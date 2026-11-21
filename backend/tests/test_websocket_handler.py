import asyncio
import logging
import types
import unittest
from unittest import mock

import websockets

import websocket_handler


class ClientCloseFrameTest(unittest.TestCase):
    def frame(self, code, reason=""):
        handler = websocket_handler.WebsocketHandler("ws://unused", "s", None)
        handler.close_code, handler.close_reason = code, reason
        return handler.client_close_frame()

    def test_mirrors_sendable_codes(self):
        self.assertEqual(self.frame(1008, "Quota exceeded"), (1008, "Quota exceeded"))
        self.assertEqual(self.frame(1000), (1000, ""))

    def test_maps_reserved_codes(self):
        self.assertEqual(self.frame(None), (1000, ""))
        self.assertEqual(self.frame(1005), (1000, ""))
        self.assertEqual(self.frame(1006), (1011, "Upstream connection lost"))

    def test_truncates_long_reasons_on_character_boundary(self):
        code, reason = self.frame(1011, "é" * 100)
        self.assertEqual(code, 1011)
        self.assertLessEqual(len(reason.encode("utf-8")), 123)
        self.assertEqual(set(reason), {"é"})


class RejectedHandshake(Exception):
    """Shaped like websockets' InvalidStatus: carries the HTTP response."""

    def __init__(self, status_code, body):
        super().__init__("rejected")
        self.response = types.SimpleNamespace(status_code=status_code, body=body)


class DescribeConnectErrorTest(unittest.TestCase):
    def test_extracts_google_api_error_message(self):
        error = RejectedHandshake(
            403, b'{"error": {"code": 403, "message": "Permission denied on project"}}'
        )
        self.assertEqual(
            websocket_handler.describe_connect_error(error),
            "Upstream HTTP 403: Permission denied on project",
        )

    def test_plain_body_and_no_response(self):
        error = RejectedHandshake(502, b"Bad gateway")
        self.assertEqual(
            websocket_handler.describe_connect_error(error),
            "Upstream HTTP 502: Bad gateway",
        )
        self.assertEqual(
            websocket_handler.describe_connect_error(OSError("refused")),
            "OSError: refused",
        )


class UpstreamLoggingTest(unittest.IsolatedAsyncioTestCase):
    async def test_debug_logging_leaves_out_the_access_token(self):
        root = logging.getLogger()
        self.addCleanup(root.setLevel, root.level)
        root.setLevel(logging.DEBUG)  # What --debug does.
        handler = websocket_handler.WebsocketHandler("wss://unused", "s", None)
        with mock.patch.object(websocket_handler, "_NoRedirectConnect") as connect:
            handler._connect_upstream("secret-token")
        options = dict(connect.call_args.kwargs)
        del options["ssl"]  # The test server is plain ws://.

        async def close(connection):
            await connection.close()

        # The server's own logger would log the header it received.
        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        async with websockets.serve(close, "127.0.0.1", 0, logger=quiet) as server:
            port = next(iter(server.sockets)).getsockname()[1]
            with self.assertLogs(level=logging.DEBUG) as logs:
                logging.getLogger().debug("captured")
                async with websockets.connect(f"ws://127.0.0.1:{port}", **options):
                    pass
        self.assertNotIn("secret-token", "\n".join(logs.output))


class UpstreamRedirectTest(unittest.IsolatedAsyncioTestCase):
    async def test_redirect_is_not_followed_with_the_token(self):
        received = []

        async def target(connection):
            received.append(connection.request.headers.get("Authorization"))
            await connection.close()

        def redirect_to_target(connection, request):
            response = connection.respond(302, "")
            response.headers["Location"] = f"ws://localhost:{target_port}/elsewhere"
            return response

        quiet = logging.getLogger("test.quiet_server")
        quiet.setLevel(logging.INFO)
        async with (
            websockets.serve(target, "127.0.0.1", 0, logger=quiet) as target_server,
            websockets.serve(
                target,
                "127.0.0.1",
                0,
                logger=quiet,
                process_request=redirect_to_target,
            ) as redirector,
        ):
            target_port = next(iter(target_server.sockets)).getsockname()[1]
            port = next(iter(redirector.sockets)).getsockname()[1]
            handler = websocket_handler.WebsocketHandler(
                f"ws://127.0.0.1:{port}/ws", "s", None
            )
            with self.assertRaises(websockets.exceptions.InvalidStatus) as caught:
                await handler._connect_upstream("secret-token")
        self.assertEqual(received, [])
        self.assertEqual(
            websocket_handler.describe_connect_error(caught.exception),
            "Upstream HTTP 302",
        )


class FakeConnection:
    def __init__(self, recv_error=None):
        self.recv_error = recv_error
        self.close_code = None
        self.close_reason = ""

    async def recv(self):
        if self.recv_error:
            raise self.recv_error
        await asyncio.Event().wait()

    async def send(self, message):
        pass

    async def close(self, code=1000, reason=""):
        self.close_code = code


class ProxyErrorTest(unittest.IsolatedAsyncioTestCase):
    async def test_unexpected_relay_error_ends_session_with_1011(self):
        # The finished task's error was never retrieved, so the session ended
        # as a clean 1000 and nothing was logged.
        upstream = FakeConnection(recv_error=RuntimeError("boom"))
        handler = websocket_handler.WebsocketHandler(
            "ws://unused", "s", FakeConnection(), keepalive_s=None
        )
        with mock.patch.object(
            handler, "_connect_upstream", return_value=asyncio.sleep(0, upstream)
        ):
            with self.assertLogs("absl", level="ERROR") as logs:
                await handler.create_proxy()
        self.assertEqual(upstream.close_code, 1011)
        self.assertEqual(
            handler.client_close_frame(), (1011, "Proxy error: RuntimeError")
        )
        self.assertIn("boom", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
