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
from typing import Any
from urllib.parse import urlparse, urlunparse

import aiohttp
from dotenv import load_dotenv
from telethon import TelegramClient, events

from alert_parser import has_crosscheck_fields
from parsers import (
    bare_id_from_entity,
    build_source_lookup,
    extract_cas,
    extract_sol_amount,
    extract_wallet_name,
    fetch_gmgn_token_metadata,
    lookup_channel_source,
    marked_channel_id,
    merge_ui_peers_over_env,
    parse_channel_env,
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
LISTEN_POLL_SECONDS = max(15, int(os.getenv("SOCIAL_LISTEN_POLL_SECONDS", "60")))

INGEST_URL = os.getenv(
    "SOCIAL_INGEST_URL",
    "http://127.0.0.1:3000/api/social/ingest",
)
INGEST_SECRET = os.getenv(
    "SOCIAL_INGEST_SECRET",
    os.getenv("TRENDING_TRACKER_SECRET", "r3l0ads0l-trending"),
)
CROSSCHECK_URL = os.getenv(
    "SIGNAL_CROSSCHECK_URL",
    INGEST_URL.replace("/api/social/ingest", "/api/social/crosscheck"),
)


def session_path() -> str:
    base = Path(SESSION_DIR)
    base.mkdir(parents=True, exist_ok=True)
    return str(base / SESSION_NAME)


def ingest_listen_url() -> str:
    parsed = urlparse(INGEST_URL)
    path = parsed.path.replace("/api/social/ingest", "/api/social/ingest-listen")
    if path == parsed.path:
        path = "/api/social/ingest-listen"
    return urlunparse(parsed._replace(path=path, query=f"key={INGEST_SECRET}"))


async def post_crosscheck(session: aiohttp.ClientSession, payload: dict) -> None:
    url = f"{CROSSCHECK_URL}?key={INGEST_SECRET}"
    async with session.post(url, json=payload) as resp:
        body = await resp.text()
        if resp.status >= 400:
            logging.error("Crosscheck failed (%s): %s", resp.status, body[:500])
        else:
            logging.info("Crosscheck OK (%s)", resp.status)


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


async def fetch_ui_listen_peers(
    session: aiohttp.ClientSession,
) -> list[tuple[str, str]]:
    """Load Strategies UI listenChannelPeers from /api/social/ingest-listen."""
    import json

    url = ingest_listen_url()
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            body = await resp.text()
            if resp.status >= 400:
                logging.warning(
                    "ingest-listen failed (%s): %s", resp.status, body[:300]
                )
                return []
            data = json.loads(body) if body.strip() else {}
    except Exception as exc:
        logging.warning("ingest-listen fetch error: %s", exc)
        return []

    if not data.get("success"):
        logging.warning("ingest-listen unsuccessful: %s", str(data)[:300])
        return []

    out: list[tuple[str, str]] = []
    for row in data.get("channels") or []:
        if not isinstance(row, dict):
            continue
        source = str(row.get("source") or "").strip()
        peer = str(row.get("peer") or "").strip()
        if source and peer:
            out.append((source, peer))
    return out


async def build_events(
    http: aiohttp.ClientSession,
    message: Any,
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
    event_type = (
        "wallet_buy" if is_wallet_channel and "buy" in text.lower() else "mention"
    )

    if len(all_cas) > MAX_CAS_PER_MESSAGE:
        logging.info(
            "Truncating %d CAs → %d (message=%s source=%s)",
            len(all_cas),
            MAX_CAS_PER_MESSAGE,
            message_id,
            source,
        )
    cas = all_cas[:MAX_CAS_PER_MESSAGE]

    excerpt = text.replace("\n", " ")[:EXCERPT_MAX] if STORE_EXCERPT else None

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


async def resolve_username_channels(
    client: TelegramClient,
    usernames: list[tuple[str, str]],
) -> list[tuple[int, str]]:
    """Resolve @username peers to bare channel ids after Telethon start."""
    out: list[tuple[int, str]] = []
    for username, source in usernames:
        try:
            entity = await client.get_entity(username)
        except Exception as exc:
            logging.error(
                "Failed to resolve channel %s username=%s: %s",
                source,
                username,
                exc,
            )
            continue
        bare_id = bare_id_from_entity(entity)
        if bare_id is None:
            logging.error(
                "Resolved %s username=%s but entity has no id",
                source,
                username,
            )
            continue
        marked = marked_channel_id(bare_id)
        logging.info(
            "Channel %s username=%s → bare=%s marked=%s",
            source,
            username,
            bare_id,
            marked,
        )
        out.append((bare_id, source))
    return out


async def resolve_channel_lists(
    client: TelegramClient,
    numeric: list[tuple[int, str]],
    usernames: list[tuple[str, str]],
) -> list[tuple[int, str]]:
    resolved = await resolve_username_channels(client, usernames)
    return [*numeric, *resolved]


async def main() -> None:
    if not API_ID or not API_HASH or not PHONE_NUMBER:
        raise SystemExit("Set API_ID, API_HASH, PHONE_NUMBER in environment")

    client = TelegramClient(session_path(), API_ID, API_HASH)
    await client.start(phone=PHONE_NUMBER)

    state: dict[str, Any] = {
        "source_by_id": {},
        "channel_ids": [],
        "signature": "",
        "handler": None,
    }

    async with aiohttp.ClientSession() as http:

        async def apply_listen_config(force_log: bool = False) -> bool:
            env_numeric, env_usernames = parse_channel_env()
            ui_peers = await fetch_ui_listen_peers(http)
            numeric, usernames, signature = merge_ui_peers_over_env(
                env_numeric, env_usernames, ui_peers
            )
            if not numeric and not usernames:
                logging.error(
                    "No channels configured (set GMGN_* env and/or Strategies "
                    "listenChannelPeers / optional TRENDINGSSOL_CHANNEL fallback)"
                )
                return False

            if signature == state["signature"] and state["handler"] is not None:
                return True

            channels = await resolve_channel_lists(client, numeric, usernames)
            if not channels:
                logging.error("No channels resolved (check peers / @usernames)")
                return False

            channel_ids, source_by_id = build_source_lookup(channels)

            if state["handler"] is not None:
                client.remove_event_handler(state["handler"])

            async def on_message(event):  # type: ignore[no-untyped-def]
                source = lookup_channel_source(
                    event.chat_id, state["source_by_id"]
                )
                if not source:
                    if LOG_SKIPS:
                        logging.warning(
                            "Skip message: unknown chat_id=%s (check listen peers)",
                            event.chat_id,
                        )
                    return

                text = event.message.raw_text or ""
                if has_crosscheck_fields(text):
                    occurred_at = event.message.date.astimezone(
                        timezone.utc
                    ).isoformat()
                    await post_crosscheck(
                        http,
                        {
                            "raw_message": text,
                            "channel_id": str(event.chat_id),
                            "external_message_id": str(event.message.id),
                            "occurred_at": occurred_at,
                        },
                    )
                    return

                payload = await build_events(
                    http, event.message, source, event.chat_id
                )
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

            client.add_event_handler(
                on_message, events.NewMessage(chats=list(channel_ids))
            )
            state["handler"] = on_message
            state["source_by_id"] = source_by_id
            state["channel_ids"] = channel_ids
            state["signature"] = signature

            logging.info(
                "Listening on %d channels (session=%s enrich_gmgn=%s max_cas=%d) → %s ui_peers=%s",
                len(channel_ids),
                session_path(),
                ENRICH_GMGN,
                MAX_CAS_PER_MESSAGE,
                INGEST_URL,
                ui_peers,
            )
            if force_log:
                logging.info("Listen signature=%s", signature)
            return True

        ok = await apply_listen_config(force_log=True)
        if not ok:
            raise SystemExit("No channels resolved at startup")

        async def poll_listen_config() -> None:
            while True:
                await asyncio.sleep(LISTEN_POLL_SECONDS)
                try:
                    await apply_listen_config()
                except Exception as exc:
                    logging.warning("Listen config reload failed: %s", exc)

        poll_task = asyncio.create_task(poll_listen_config())
        try:
            await client.run_until_disconnected()
        finally:
            poll_task.cancel()
            try:
                await poll_task
            except asyncio.CancelledError:
                pass


if __name__ == "__main__":
    asyncio.run(main())
