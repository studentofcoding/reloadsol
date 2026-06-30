"""Channel + message parsers ported from telegram_tracker/main.py (listen-only subset)."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from telethon import utils

BASE58_CA = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
SOL_AMOUNT_INLINE = re.compile(r"(\d+(?:\.\d+)?)\s*SOL", re.IGNORECASE)
SOL_AMOUNT_BUY = re.compile(r"buy\s+(\d+(?:\.\d+)?)\s*sol", re.IGNORECASE)
GMGN_QUOTE_URL = "https://gmgn.ai/defi/quotation/v1/tokens/sol/{ca}"

# (env_var, source_label, use_positive_resolve) — mirrors telegram_tracker/main.py sign rules
CHANNEL_ENV_CONFIG: list[tuple[str, str, bool]] = [
    ("GMGN_ID", "GMGN", False),
    ("JUNGOOL_ID", "JUNGOOL", False),
    ("GMGN_TRACKER_ID", "GMGN_copy_trade", True),
    ("GMGN_SOLANA_FDV_AND_SMART_MONEY_ID", "GMGN_Smart_Money_FOMO", False),
    ("FINDER_TRENDING_ID", "FINDER_Trending", False),
    ("GAMBLES_ID", "GAMBLES", False),
    ("JOJI_INNER_ID", "JOJI", False),
    ("STONK_CALLS_ID", "STONK_CALLS", False),
]


def channel_sources_from_env() -> dict[str, str]:
    """Raw env value → source label (for logging)."""
    out: dict[str, str] = {}
    for env_key, source, _ in CHANNEL_ENV_CONFIG:
        raw = (os.getenv(env_key) or "").strip()
        if raw:
            out[raw] = source
    return out


def resolve_channel_peer_id(raw_id: int, use_positive: bool) -> int:
    peer_input = raw_id if use_positive else -raw_id
    resolved, _peer_type = utils.resolve_id(peer_input)
    return int(resolved)


def marked_channel_id(bare_channel_id: int) -> int:
    """Telethon event.chat_id uses marked ids (e.g. -1001872223162)."""
    from telethon.tl.types import PeerChannel

    return utils.get_peer_id(PeerChannel(channel_id=bare_channel_id))


def build_source_lookup(
    channels: list[tuple[int, str]],
) -> tuple[list[int], dict[int, str]]:
    """
    Map both marked and bare channel ids → source label.
    Returns (marked_ids for NewMessage filter, lookup dict).
    """
    source_by_id: dict[int, str] = {}
    marked_ids: list[int] = []

    for bare_id, source in channels:
        marked = marked_channel_id(bare_id)
        source_by_id[bare_id] = source
        source_by_id[marked] = source
        if marked not in marked_ids:
            marked_ids.append(marked)

    return marked_ids, source_by_id


def lookup_channel_source(chat_id: int, source_by_id: dict[int, str]) -> str | None:
    source = source_by_id.get(chat_id)
    if source:
        return source
    try:
        resolved, _ = utils.resolve_id(chat_id)
        return source_by_id.get(int(resolved))
    except (TypeError, ValueError):
        return None


def parse_channel_ids() -> list[tuple[int, str]]:
    """Resolve bare Telethon channel ids from env channel config."""
    out: list[tuple[int, str]] = []
    for env_key, source, use_positive in CHANNEL_ENV_CONFIG:
        raw = (os.getenv(env_key) or "").strip()
        if not raw.lstrip("-").isdigit():
            continue
        raw_id = int(raw)
        bare_id = resolve_channel_peer_id(raw_id, use_positive)
        marked = marked_channel_id(bare_id)
        logging.info(
            "Channel %s env=%s raw=%s → bare=%s marked=%s",
            source,
            env_key,
            raw_id,
            bare_id,
            marked,
        )
        out.append((bare_id, source))
    return out


def extract_ca_with_pump(message: str) -> str | None:
    if "solscan" in message:
        pattern = r"https://solscan\.io/token/([\w\d]+)"
    else:
        pattern = r".*/([^/]*pump)$"
    match = re.search(pattern, message)
    if match:
        return match.group(1)
    return None


def extract_cas(text: str, *, max_count: int | None = None) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []

    pump_ca = extract_ca_with_pump(text)
    if pump_ca and pump_ca != "Unknown" and BASE58_CA.fullmatch(pump_ca):
        seen.add(pump_ca)
        ordered.append(pump_ca)

    for match in BASE58_CA.findall(text):
        if match in seen:
            continue
        seen.add(match)
        ordered.append(match)
        if max_count is not None and len(ordered) >= max_count:
            break

    return ordered


def extract_wallet_name(text: str) -> str | None:
    first_line = text.split("\n", 1)[0].strip()
    match = re.search(r"^[^\w]*(.+?)\s+(buy|sell)", first_line, re.IGNORECASE)
    return match.group(1).strip() if match else None


def extract_sol_amount(text: str) -> float | None:
    match = SOL_AMOUNT_BUY.search(text) or SOL_AMOUNT_INLINE.search(text)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


async def fetch_gmgn_token_metadata(
    http_session: Any,
    ca: str,
    *,
    timeout_sec: float = 4.0,
) -> dict[str, Any]:
    """Best-effort GMGN quotation enrichment for raw_metadata."""
    url = GMGN_QUOTE_URL.format(ca=ca)
    try:
        async with http_session.get(url, timeout=timeout_sec) as response:
            if response.status != 200:
                return {}
            data = await response.json()
    except Exception as exc:
        logging.debug("GMGN enrich skipped for %s: %s", ca[:8], exc)
        return {}

    token = (data or {}).get("data", {}).get("token", {}) or {}
    out: dict[str, Any] = {}
    if token.get("symbol"):
        out["symbol"] = token["symbol"]
    if token.get("market_cap") is not None:
        out["mcp"] = token["market_cap"]
    if token.get("net_in_volume_1m") is not None:
        out["net_in_volume_1m"] = token["net_in_volume_1m"]
    return out
