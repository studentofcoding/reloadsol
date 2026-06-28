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


def parse_channel_ids() -> list[tuple[int, str]]:
    """Resolve Telethon peer IDs from env channel config."""
    out: list[tuple[int, str]] = []
    for env_key, source, use_positive in CHANNEL_ENV_CONFIG:
        raw = (os.getenv(env_key) or "").strip()
        if not raw.lstrip("-").isdigit():
            continue
        raw_id = int(raw)
        peer_id = resolve_channel_peer_id(raw_id, use_positive)
        logging.info(
            "Channel %s env=%s raw=%s → peer_id=%s",
            source,
            env_key,
            raw_id,
            peer_id,
        )
        out.append((peer_id, source))
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


def extract_cas(text: str) -> list[str]:
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
