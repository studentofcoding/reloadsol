"""Parse rich Telegram alpha alerts (coin fields only — channel name is manual)."""

from __future__ import annotations

import re
from typing import Any

BASE58_CA = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
PUMP_SUFFIX = re.compile(r"/([^/\s]*pump)\s*$", re.MULTILINE)


def _parse_mcap_value(raw: str, suffix: str | None) -> float | None:
    try:
        num = float(raw)
    except ValueError:
        return None
    s = (suffix or "").upper()
    if s == "K":
        return num * 1_000
    if s == "M":
        return num * 1_000_000
    if s == "B":
        return num * 1_000_000_000
    return num


def _extract_token_address(text: str) -> str | None:
    pump_match = PUMP_SUFFIX.search(text)
    if pump_match and BASE58_CA.fullmatch(pump_match.group(1)):
        return pump_match.group(1)

    for match in BASE58_CA.findall(text):
        if match.endswith("pump"):
            return match
    matches = BASE58_CA.findall(text)
    return matches[0] if matches else None


def _parse_title_line(text: str) -> tuple[str | None, str | None]:
    first_line = text.split("\n", 1)[0].strip() if text else ""
    if not first_line:
        return None, None

    symbol_match = re.search(r"\(([^)]+)\)", first_line)
    token_symbol = symbol_match.group(1).strip() if symbol_match else None

    token_name = first_line
    if symbol_match:
        token_name = first_line[: symbol_match.start()].strip()
    token_name = re.sub(r"\s*NEW\s+ALERT.*$", "", token_name, flags=re.IGNORECASE).strip()

    return token_name or None, token_symbol


def parse_telegram_alert(raw_message: str) -> dict[str, Any] | None:
    text = (raw_message or "").strip()
    if not text:
        return None

    token_address = _extract_token_address(text)
    if not token_address:
        return None

    price_match = re.search(r"USD:\s*\$([\d.]+)", text, re.IGNORECASE)
    if not price_match:
        return None
    try:
        signal_price_usd = float(price_match.group(1))
    except ValueError:
        return None
    if signal_price_usd <= 0:
        return None

    pct_match = re.search(
        r"USD:\s*\$[\d.]+\s*\(\+?(-?\d+(?:\.\d+)?)%\)",
        text,
        re.IGNORECASE,
    )
    signal_pct_change = float(pct_match.group(1)) if pct_match else None

    mcap_match = re.search(r"MC:\s*\$([\d.]+)\s*(K|M|B)?", text, re.IGNORECASE)
    market_cap_usd = (
        _parse_mcap_value(mcap_match.group(1), mcap_match.group(2))
        if mcap_match
        else None
    )

    dex_match = re.search(r"Dex:\s*(\S+)", text, re.IGNORECASE)
    dex = dex_match.group(1).strip() if dex_match else None

    buy_match = re.search(r"Last\s+3\s+mins\s+buy:\s*([\d.]+)\s*SOL", text, re.IGNORECASE)
    buy_sol_3m = float(buy_match.group(1)) if buy_match else None

    token_name, token_symbol = _parse_title_line(text)

    return {
        "token_address": token_address,
        "token_name": token_name,
        "token_symbol": token_symbol,
        "signal_price_usd": signal_price_usd,
        "signal_pct_change": signal_pct_change,
        "market_cap_usd": market_cap_usd,
        "dex": dex,
        "buy_sol_3m": buy_sol_3m,
    }


def has_crosscheck_fields(raw_message: str) -> bool:
    parsed = parse_telegram_alert(raw_message)
    return parsed is not None and parsed.get("signal_price_usd") is not None
