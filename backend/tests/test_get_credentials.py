import datetime
import threading
import time
import unittest
from unittest import mock

import get_credentials


def _token(minutes_left, source="fake"):
    expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        minutes=minutes_left
    )
    return get_credentials.AccessToken(f"token-{source}", expiry, source)


class GetAccessTokenTest(unittest.TestCase):
    def setUp(self):
        get_credentials._cached_token = None
        self.addCleanup(setattr, get_credentials, "_cached_token", None)

    def use_sources(self, *fetchers):
        patcher = mock.patch.object(
            get_credentials,
            "_SOURCES",
            tuple((f"source{i}", f) for i, f in enumerate(fetchers)),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_falls_through_failing_sources(self):
        def failing():
            raise RuntimeError("Account restricted")

        self.use_sources(failing, lambda: _token(60, "gcloud"))
        self.assertEqual(get_credentials.get_access_token().source, "gcloud")

    def test_caches_until_near_expiry(self):
        fetch = mock.Mock(side_effect=[_token(60, "first"), _token(60, "second")])
        self.use_sources(fetch)
        self.assertEqual(get_credentials.get_access_token().source, "first")
        self.assertEqual(get_credentials.get_access_token().source, "first")
        self.assertEqual(fetch.call_count, 1)

        get_credentials._cached_token = _token(1, "stale")
        self.assertEqual(get_credentials.get_access_token().source, "second")

    def test_reports_every_failure(self):
        def failing_a():
            raise RuntimeError("no ADC")

        def failing_b():
            raise FileNotFoundError("no gcloud")

        self.use_sources(failing_a, failing_b)
        with self.assertRaisesRegex(RuntimeError, "no ADC.*no gcloud"):
            get_credentials.get_access_token()

    def test_waiting_callers_share_a_failed_fetch(self):
        release = threading.Event()

        def slow_failure():
            release.wait()
            raise RuntimeError("gcloud down")

        fetch = mock.Mock(side_effect=slow_failure)
        self.use_sources(fetch)
        errors = []

        def call():
            try:
                get_credentials.get_access_token()
            except RuntimeError as e:
                errors.append(str(e))

        threads = [threading.Thread(target=call) for _ in range(4)]
        threads[0].start()
        while not fetch.called:
            time.sleep(0.01)
        for thread in threads[1:]:
            thread.start()
        time.sleep(0.3)  # Lets the others queue on the lock.
        release.set()
        for thread in threads:
            thread.join(timeout=5)

        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(len(errors), 4)
        self.assertEqual(len(set(errors)), 1)
        self.assertIn("gcloud down", errors[0])

    def test_waiting_caller_gives_up_on_a_stuck_fetch(self):
        self.enterContext(mock.patch.object(get_credentials, "FETCH_TIMEOUT_S", 0.3))
        fetching, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def stuck():
            fetching.set()
            release.wait(10)
            return _token(60, "late")

        self.use_sources(stuck)
        first = threading.Thread(target=get_credentials.get_access_token)
        first.start()
        self.assertTrue(fetching.wait(5))
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "Timed out after 0.3 s"):
            get_credentials.get_access_token()
        self.assertLess(time.monotonic() - started, 3)
        # The stuck fetch still caches its token for later callers.
        release.set()
        first.join(timeout=5)
        self.assertEqual(get_credentials.get_access_token().source, "late")

    def test_retries_after_a_failed_fetch(self):
        fetch = mock.Mock(side_effect=[RuntimeError("down"), _token(60, "later")])
        self.use_sources(fetch)
        with self.assertRaises(RuntimeError):
            get_credentials.get_access_token()
        self.assertEqual(get_credentials.get_access_token().source, "later")

    def test_adc_without_token_falls_through(self):
        adc = mock.Mock(token=None, expiry=None)
        self.enterContext(mock.patch.object(get_credentials, "_adc_credentials", None))
        with mock.patch.object(
            get_credentials.google.auth, "default", return_value=(adc, "project")
        ):
            self.use_sources(
                get_credentials._token_from_adc, lambda: _token(60, "gcloud")
            )
            self.assertEqual(get_credentials.get_access_token().source, "gcloud")
        adc.refresh.assert_called_once()

    def test_adc_token(self):
        adc = mock.Mock(token="adc-token", expiry=None)
        self.enterContext(mock.patch.object(get_credentials, "_adc_credentials", None))
        with mock.patch.object(
            get_credentials.google.auth, "default", return_value=(adc, "project")
        ) as default:
            token = get_credentials._token_from_adc()
            get_credentials._token_from_adc()
        self.assertEqual((token.token, token.source), ("adc-token", "adc"))
        self.assertIsInstance(
            adc.refresh.call_args.args[0], get_credentials._TimedRequest
        )
        self.assertIsNotNone(token.expiry.tzinfo)
        # The credentials object is created once and refreshed on each call.
        default.assert_called_once()
        self.assertEqual(adc.refresh.call_count, 2)

    def test_adc_requests_time_out_sooner_than_google_auth_default(self):
        session = mock.Mock()
        request = get_credentials._TimedRequest(session=session)
        request("https://oauth2.googleapis.com/token", method="POST")
        self.assertEqual(
            session.request.call_args.kwargs["timeout"],
            get_credentials.ADC_REQUEST_TIMEOUT_S,
        )
        # A caller's own timeout (the metadata server's, say) still wins.
        request("http://metadata.google.internal", timeout=3)
        self.assertEqual(session.request.call_args.kwargs["timeout"], 3)

    def test_chain_credentials_refresh(self):
        self.use_sources(lambda: _token(60))
        creds = get_credentials.ChainCredentials()
        creds.refresh(None)
        self.assertEqual(creds.token, "token-fake")
        self.assertIsNone(creds.expiry.tzinfo)
        self.assertTrue(creds.valid)


if __name__ == "__main__":
    unittest.main()
