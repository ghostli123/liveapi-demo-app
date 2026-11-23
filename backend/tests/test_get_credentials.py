import asyncio
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

    def test_failed_refresh_reuses_a_still_valid_token(self):
        def failing():
            raise RuntimeError("gcloud down")

        self.use_sources(failing)
        get_credentials._cached_token = _token(1.5, "cached")
        with self.assertLogs(level="WARNING") as logs:
            self.assertEqual(get_credentials.get_access_token().source, "cached")
        output = "\n".join(logs.output)
        self.assertIn("Reusing the cached token from cached", output)
        self.assertIn("gcloud down", output)
        self.assertNotIn("token-cached", output)

        get_credentials._cached_token = _token(10 / 60, "almost-expired")
        with self.assertRaisesRegex(RuntimeError, "gcloud down"):
            get_credentials.get_access_token()

    def test_waiting_callers_reuse_a_still_valid_token_after_a_failure(self):
        get_credentials._cached_token = _token(1.5, "cached")
        release = threading.Event()

        def slow_failure():
            release.wait()
            raise RuntimeError("gcloud down")

        fetch = mock.Mock(side_effect=slow_failure)
        self.use_sources(fetch)
        sources = []
        threads = [
            threading.Thread(
                target=lambda: sources.append(get_credentials.get_access_token().source)
            )
            for _ in range(4)
        ]
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
        self.assertEqual(sources, ["cached"] * 4)

    def test_waiting_caller_reuses_a_still_valid_token_during_a_stuck_fetch(self):
        self.enterContext(mock.patch.object(get_credentials, "FETCH_TIMEOUT_S", 0.3))
        get_credentials._cached_token = _token(1.5, "cached")
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
        self.assertEqual(get_credentials.get_access_token().source, "cached")
        self.assertLess(time.monotonic() - started, 3)
        release.set()
        first.join(timeout=5)

    def test_retries_after_a_failed_fetch(self):
        fetch = mock.Mock(side_effect=[RuntimeError("down"), _token(60, "later")])
        self.use_sources(fetch)
        with self.assertRaises(RuntimeError):
            get_credentials.get_access_token()
        self.assertEqual(get_credentials.get_access_token().source, "later")

    def test_invalidate_drops_only_the_cached_token(self):
        cached = _token(60, "cached")
        get_credentials._cached_token = cached
        self.assertFalse(get_credentials.invalidate(_token(60, "other")))
        self.assertIs(get_credentials._cached_token, cached)
        # Matched by the token itself, whichever object carries it.
        self.assertTrue(get_credentials.invalidate(_token(60, "cached")))
        self.assertIsNone(get_credentials._cached_token)
        self.assertFalse(get_credentials.invalidate(cached))

    def test_invalidated_token_is_not_reused_when_refresh_fails(self):
        cached = _token(60, "cached")
        get_credentials._cached_token = cached
        get_credentials.invalidate(cached)

        def failing():
            raise RuntimeError("Account restricted")

        self.use_sources(failing)
        with self.assertRaisesRegex(RuntimeError, "Account restricted"):
            get_credentials.get_access_token()

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
        self.assertFalse(creds.expired)

    def test_chain_credentials_follow_cache_invalidation(self):
        fetch = mock.Mock(side_effect=[_token(60, "first"), _token(60, "second")])
        self.use_sources(fetch)
        creds = get_credentials.ChainCredentials()
        creds.refresh(None)
        self.assertEqual(creds.token, "token-first")
        self.assertFalse(creds.expired)
        self.assertTrue(creds.valid)

        # Dropping the cached token (e.g. after a Live API 1008 or simulator
        # 401) must mark ChainCredentials expired so google-genai refreshes.
        cached = get_credentials._cached_token
        assert cached is not None
        self.assertTrue(get_credentials.invalidate(cached))
        self.assertTrue(creds.expired)
        self.assertFalse(creds.valid)
        self.assertEqual(
            creds.token_state,
            get_credentials.google.auth.credentials.TokenState.INVALID,
        )

        creds.refresh(None)
        self.assertEqual(creds.token, "token-second")
        self.assertFalse(creds.expired)
        self.assertTrue(creds.valid)

        # A newer token cached by another caller also marks the old copy stale.
        get_credentials._cached_token = _token(60, "third")
        self.assertTrue(creds.expired)
        self.assertFalse(creds.valid)
        creds.refresh(None)
        self.assertEqual(creds.token, "token-third")
        self.assertEqual(fetch.call_count, 2)


class FetchAccessTokenTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        get_credentials._cached_token = None
        self.addCleanup(setattr, get_credentials, "_cached_token", None)
        self.enterContext(mock.patch.object(get_credentials, "FETCH_TIMEOUT_S", 0.3))
        self.release = threading.Event()
        self.addCleanup(self.release.set)

    def use_source(self, fetch):
        self.enterContext(
            mock.patch.object(get_credentials, "_SOURCES", (("source", fetch),))
        )

    def stuck(self):
        self.release.wait(10)
        raise RuntimeError("stuck source")

    async def test_fresh_cached_token_needs_no_thread(self):
        get_credentials._cached_token = _token(60, "cached")
        self.enterContext(
            mock.patch.object(get_credentials, "_EXECUTOR", mock.Mock(spec=[]))
        )
        token = await get_credentials.fetch_access_token()
        self.assertEqual(token.source, "cached")

    async def test_fetches_on_the_token_threads(self):
        threads = []

        def fetch():
            threads.append(threading.current_thread().name)
            return _token(60, "fetched")

        self.use_source(fetch)
        self.assertEqual((await get_credentials.fetch_access_token()).source, "fetched")
        self.assertEqual(len(threads), 1)
        self.assertTrue(threads[0].startswith("token"), threads)

    async def test_deadline_reuses_a_still_valid_token(self):
        get_credentials._cached_token = _token(1.5, "cached")
        self.use_source(self.stuck)
        token = await get_credentials.fetch_access_token()
        self.assertEqual(token.source, "cached")

    async def test_deadline_without_a_usable_token_raises(self):
        self.use_source(self.stuck)
        with self.assertRaisesRegex(RuntimeError, "Timed out after 0.3 s"):
            await get_credentials.fetch_access_token()

    async def test_calls_queued_behind_busy_threads_fall_back_at_the_deadline(self):
        get_credentials._cached_token = _token(1.5, "cached")
        self.use_source(self.stuck)
        calls = [
            get_credentials.fetch_access_token()
            for _ in range(get_credentials._EXECUTOR._max_workers + 2)
        ]
        async with asyncio.timeout(2):
            tokens = await asyncio.gather(*calls)
        self.assertEqual({t.source for t in tokens}, {"cached"})

    async def test_unbounded_waits_past_the_deadline(self):
        def slow():
            time.sleep(0.6)
            return _token(60, "slow")

        self.use_source(slow)
        token = await get_credentials.fetch_access_token(bounded=False)
        self.assertEqual(token.source, "slow")


if __name__ == "__main__":
    unittest.main()
