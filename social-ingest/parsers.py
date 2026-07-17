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
    # Fallback only — prefer Strategies UI listenChannelPeers via ingest-listen API
    ("TRENDINGSSOL_CHANNEL", "TRENDINGSSOL", False),
]

# source label → use_positive resolve (mirrors CHANNEL_ENV_CONFIG)
SOURCE_USE_POSITIVE: dict[str, bool] = {
    source: use_positive for _env, source, use_positive in CHANNEL_ENV_CONFIG
}

USERNAME_RE = re.compile(r"^@?[A-Za-z][\w\d]{3,31}$")


def normalize_channel_username(raw: str) -> str | None:
    """Return Telethon-friendly username (with @) or None if not a username shape."""
    value = (raw or "").strip()
    if not value or value.lstrip("-").isdigit():
        return None
    if not USERNAME_RE.fullmatch(value):
        return None
    return value if value.startswith("@") else f"@{value}"


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


def parse_peer_value(
    raw: str,
    source: str,
    *,
    use_positive: bool | None = None,
    origin: str = "peer",
) -> tuple[str, int | str, str] | None:
    """
    Parse a channel peer into ('numeric', bare_id, source) or ('username', @user, source).
    Returns None if the value is not a numeric id or username shape.
    """
    value = (raw or "").strip()
    if not value:
        return None
    positive = (
        SOURCE_USE_POSITIVE.get(source, False)
        if use_positive is None
        else use_positive
    )
    if value.lstrip("-").isdigit():
        bare_id = resolve_channel_peer_id(int(value), positive)
        marked = marked_channel_id(bare_id)
        logging.info(
            "Channel %s %s raw=%s → bare=%s marked=%s",
            source,
            origin,
            value,
            bare_id,
            marked,
        )
        return ("numeric", bare_id, source)
    username = normalize_channel_username(value)
    if username:
        logging.info(
            "Channel %s %s username=%s (resolve after Telethon start)",
            source,
            origin,
            username,
        )
        return ("username", username, source)
    logging.warning(
        "Channel %s %s raw=%r ignored (not numeric id or @username)",
        source,
        origin,
        value,
    )
    return None


def parse_channel_env() -> tuple[list[tuple[int, str]], list[tuple[str, str]]]:
    """
    Parse CHANNEL_ENV_CONFIG into:
    - numeric: list of (bare_channel_id, source)
    - usernames: list of (@username, source) pending Telethon resolve
    """
    numeric: list[tuple[int, str]] = []
    usernames: list[tuple[str, str]] = []
    for env_key, source, use_positive in CHANNEL_ENV_CONFIG:
        raw = (os.getenv(env_key) or "").strip()
        if not raw:
            continue
        parsed = parse_peer_value(
            raw, source, use_positive=use_positive, origin=f"env={env_key}"
        )
        if parsed is None:
            continue
        kind, value, src = parsed
        if kind == "numeric":
            numeric.append((int(value), src))
        else:
            usernames.append((str(value), src))
    return numeric, usernames


def merge_ui_peers_over_env(
    env_numeric: list[tuple[int, str]],
    env_usernames: list[tuple[str, str]],
    ui_peers: list[tuple[str, str]],
) -> tuple[list[tuple[int, str]], list[tuple[str, str]], str]:
    """
    UI peers (source, peer) override env entries with the same source label.
    Returns (numeric, usernames, signature) where signature is stable for change detection.
    """
    ui_sources = {source for source, _peer in ui_peers if source.strip()}
    numeric = [(bid, src) for bid, src in env_numeric if src not in ui_sources]
    usernames = [(user, src) for user, src in env_usernames if src not in ui_sources]

    sig_parts: list[str] = []
    for source, peer in sorted(ui_peers, key=lambda x: x[0]):
        source = source.strip()
        peer = peer.strip()
        if not source or not peer:
            continue
        sig_parts.append(f"{source}={peer}")
        parsed = parse_peer_value(peer, source, origin="ui")
        if parsed is None:
            continue
        kind, value, src = parsed
        if kind == "numeric":
            numeric.append((int(value), src))
        else:
            usernames.append((str(value), src))

    # Include remaining env sources in signature so env-only changes also reload
    for bid, src in sorted(numeric, key=lambda x: x[1]):
        if src not in ui_sources:
            sig_parts.append(f"{src}=id:{bid}")
    for user, src in sorted(usernames, key=lambda x: x[1]):
        if src not in ui_sources:
            sig_parts.append(f"{src}={user}")

    return numeric, usernames, "|".join(sig_parts)


def parse_channel_ids() -> list[tuple[int, str]]:
    """Resolve bare Telethon channel ids from numeric env values only."""
    numeric, _usernames = parse_channel_env()
    return numeric


def bare_id_from_entity(entity: Any) -> int | None:
    """Best-effort bare channel id from a Telethon entity."""
    channel_id = getattr(entity, "id", None)
    if channel_id is None:
        return None
    try:
        return int(channel_id)
    except (TypeError, ValueError):
        return None


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
