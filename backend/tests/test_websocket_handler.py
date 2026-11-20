import types
import unittest

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


if __name__ == "__main__":
    unittest.main()
