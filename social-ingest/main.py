#!/usr/bin/env python3
"""
Telethon sidecar — listens to configured Telegram channels and POSTs parsed
token events to buy_bulk /api/social/ingest.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import timezone
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from telethon import TelegramClient, events

from parsers import (
    build_source_lookup,
    extract_cas,
    extract_sol_amount,
    extract_wallet_name,
    fetch_gmgn_token_metadata,
    lookup_channel_source,
    parse_channel_ids,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [social-ingest] %(message)s",
)
# Telethon "Got difference for channel …" is sync noise, not ingest activity.
logging.getLogger("telethon").setLevel(logging.WARNING)

API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
PHONE_NUMBER = os.getenv("PHONE_NUMBER", "")
SESSION_NAME = os.getenv("SOCIAL_SESSION_NAME", "session_search")
SESSION_DIR = os.getenv("SESSION_DIR", "social-ingest/sessions")
ENRICH_GMGN = os.getenv("SOCIAL_ENRICH_GMGN", "false").lower() in ("1", "true", "yes")
LOG_SKIPS = os.getenv("SOCIAL_INGEST_LOG_SKIPS", "true").lower() in ("1", "true", "yes")
MAX_CAS_PER_MESSAGE = max(1, int(os.getenv("SOCIAL_MAX_CAS_PER_MESSAGE", "3")))
STORE_EXCERPT = os.getenv("SOCIAL_STORE_EXCERPT", "false").lower() in ("1", "true", "yes")
EXCERPT_MAX = min(500, max(40, int(os.getenv("SOCIAL_EXCERPT_MAX", "120"))))

INGEST_URL = os.getenv(
    "SOCIAL_INGEST_URL",
    "http://127.0.0.1:3000/api/social/ingest",
)
INGEST_SECRET = os.getenv(
    "SOCIAL_INGEST_SECRET",
    os.getenv("TRENDING_TRACKER_SECRET", "r3l0ads0l-trending"),
)


def session_path() -> str:
    base = Path(SESSION_DIR)
    base.mkdir(parents=True, exist_ok=True)
    return str(base / SESSION_NAME)


async def post_events(session: aiohttp.ClientSession, events_payload: list[dict]) -> None:
    if not events_payload:
        return
    url = f"{INGEST_URL}?key={INGEST_SECRET}"
    async with session.post(url, json={"events": events_payload}) as resp:
        body = await resp.text()
        if resp.status >= 400:
            logging.error("Ingest failed (%s): %s", resp.status, body[:500])
        else:
            logging.info("Ingest OK (%s): %s events", resp.status, len(events_payload))


async def build_events(
    http: aiohttp.ClientSession,
    message,
    source: str,
    channel_id: int,
) -> list[dict]:
    text = message.raw_text or ""
    if not text.strip():
        return []

    occurred_at = message.date.astimezone(timezone.utc).isoformat()
    channel_label = source
    message_id = str(message.id)
    all_cas = extract_cas(text)
    if not all_cas:
        return []

    wallet_name = extract_wallet_name(text)
    sol_amount = extract_sol_amount(text)
    is_wallet_channel = source == "GMGN_copy_trade"
    event_type = "wallet_buy" if is_wallet_channel and "buy" in text.lower() else "mention"

    if len(all_cas) > MAX_CAS_PER_MESSAGE:
        logging.info(
            "Truncating %d CAs → %d (message=%s source=%s)",
            len(all_cas),
            MAX_CAS_PER_MESSAGE,
            message_id,
            source,
        )
    cas = all_cas[:MAX_CAS_PER_MESSAGE]

    excerpt = (
        text.replace("\n", " ")[:EXCERPT_MAX] if STORE_EXCERPT else None
    )

    events_out: list[dict] = []
    for index, ca in enumerate(cas):
        raw_metadata: dict = {}
        if event_type == "wallet_buy" and sol_amount is not None:
            raw_metadata["sol_amount"] = sol_amount
        if excerpt and index == 0:
            raw_metadata["excerpt"] = excerpt
        if ENRICH_GMGN and index == 0:
            raw_metadata.update(await fetch_gmgn_token_metadata(http, ca))

        events_out.append(
            {
                "token_address": ca,
                "event_type": event_type,
                "source": source,
                "channel_id": str(channel_id),
                "channel_label": channel_label,
                "wallet_label": wallet_name,
                "external_message_id": message_id,
                "occurred_at": occurred_at,
                "raw_metadata": raw_metadata,
            }
        )
    return events_out


async def main() -> None:
    if not API_ID or not API_HASH or not PHONE_NUMBER:
        raise SystemExit("Set API_ID, API_HASH, PHONE_NUMBER in environment")

    channels = parse_channel_ids()
    if not channels:
        raise SystemExit("No channel IDs configured (GMGN_*, FINDER_TRENDING_ID, etc.)")

    channel_ids, source_by_id = build_source_lookup(channels)

    client = TelegramClient(session_path(), API_ID, API_HASH)
    await client.start(phone=PHONE_NUMBER)

    logging.info(
        "Listening on %d channels (session=%s enrich_gmgn=%s max_cas=%d) → %s",
        len(channel_ids),
        session_path(),
        ENRICH_GMGN,
        MAX_CAS_PER_MESSAGE,
        INGEST_URL,
    )

    async with aiohttp.ClientSession() as http:

        @client.on(events.NewMessage(chats=channel_ids))
        async def handler(event):  # type: ignore[no-redef]
            source = lookup_channel_source(event.chat_id, source_by_id)
            if not source:
                if LOG_SKIPS:
                    logging.warning(
                        "Skip message: unknown chat_id=%s (check channel env ids)",
                        event.chat_id,
                    )
                return

            text = event.message.raw_text or ""
            payload = await build_events(http, event.message, source, event.chat_id)

            if not payload:
                if LOG_SKIPS and text.strip():
                    excerpt = text.replace("\n", " ")[:120]
                    logging.info(
                        "Skip message (no token CA): source=%s chat_id=%s excerpt=%r",
                        source,
                        event.chat_id,
                        excerpt,
                    )
                return

            await post_events(http, payload)

        await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
