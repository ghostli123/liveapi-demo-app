import datetime
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

    def test_chain_credentials_refresh(self):
        self.use_sources(lambda: _token(60))
        creds = get_credentials.ChainCredentials()
        creds.refresh(None)
        self.assertEqual(creds.token, "token-fake")
        self.assertIsNone(creds.expiry.tzinfo)
        self.assertTrue(creds.valid)


if __name__ == "__main__":
    unittest.main()
