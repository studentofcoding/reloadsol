"""Unit tests for channel env parse (numeric + username). Run: python -m unittest test_parsers_channel_env.py"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from parsers import (
    CHANNEL_ENV_CONFIG,
    merge_ui_peers_over_env,
    normalize_channel_username,
    parse_channel_env,
    parse_channel_ids,
    parse_peer_value,
)


def _clear_channel_env() -> dict[str, str]:
    return {key: "" for key, _, _ in CHANNEL_ENV_CONFIG}


class NormalizeChannelUsernameTest(unittest.TestCase):
    def test_at_prefix(self) -> None:
        self.assertEqual(normalize_channel_username("@trendingssol"), "@trendingssol")

    def test_plain_username(self) -> None:
        self.assertEqual(normalize_channel_username("trendingssol"), "@trendingssol")

    def test_numeric_returns_none(self) -> None:
        self.assertIsNone(normalize_channel_username("-1001234567890"))
        self.assertIsNone(normalize_channel_username("1234567890"))

    def test_junk_returns_none(self) -> None:
        self.assertIsNone(normalize_channel_username("not a user"))
        self.assertIsNone(normalize_channel_username(""))


class ParsePeerValueTest(unittest.TestCase):
    def test_username(self) -> None:
        parsed = parse_peer_value("@trendingssol", "TRENDINGSSOL", origin="test")
        self.assertEqual(parsed, ("username", "@trendingssol", "TRENDINGSSOL"))

    def test_numeric(self) -> None:
        parsed = parse_peer_value("-1001872223162", "TRENDINGSSOL", origin="test")
        assert parsed is not None
        self.assertEqual(parsed[0], "numeric")
        self.assertEqual(parsed[2], "TRENDINGSSOL")
        self.assertIsInstance(parsed[1], int)


class ParseChannelEnvTest(unittest.TestCase):
    def test_username_not_dropped(self) -> None:
        env = {**_clear_channel_env(), "TRENDINGSSOL_CHANNEL": "@trendingssol"}
        with patch.dict(os.environ, env, clear=False):
            numeric, usernames = parse_channel_env()
        self.assertEqual(numeric, [])
        self.assertEqual(usernames, [("@trendingssol", "TRENDINGSSOL")])

    def test_plain_username_pending_resolve(self) -> None:
        env = {**_clear_channel_env(), "TRENDINGSSOL_CHANNEL": "trendingssol"}
        with patch.dict(os.environ, env, clear=False):
            _numeric, usernames = parse_channel_env()
        self.assertEqual(usernames, [("@trendingssol", "TRENDINGSSOL")])

    def test_numeric_still_works(self) -> None:
        env = {**_clear_channel_env(), "TRENDINGSSOL_CHANNEL": "-1001872223162"}
        with patch.dict(os.environ, env, clear=False):
            numeric, usernames = parse_channel_env()
            ids_only = parse_channel_ids()
        self.assertEqual(usernames, [])
        self.assertEqual(len(numeric), 1)
        self.assertEqual(numeric[0][1], "TRENDINGSSOL")
        self.assertEqual(ids_only, numeric)


class MergeUiPeersTest(unittest.TestCase):
    def test_ui_overrides_env_same_source(self) -> None:
        env = {**_clear_channel_env(), "TRENDINGSSOL_CHANNEL": "@fromenv"}
        with patch.dict(os.environ, env, clear=False):
            env_numeric, env_usernames = parse_channel_env()
        self.assertEqual(env_usernames, [("@fromenv", "TRENDINGSSOL")])
        numeric, usernames, sig = merge_ui_peers_over_env(
            env_numeric,
            env_usernames,
            [("TRENDINGSSOL", "@trendingssol")],
        )
        self.assertEqual(numeric, [])
        self.assertEqual(usernames, [("@trendingssol", "TRENDINGSSOL")])
        self.assertIn("TRENDINGSSOL=@trendingssol", sig)
        self.assertNotIn("@fromenv", sig)


if __name__ == "__main__":
    unittest.main()
