# SPEC — Entry-time context freeze v1

**Status:** implemented behind `ENTRY_CONTEXT_FREEZE` (default **off**)  
**Date:** 2026-10-04  
**Extends:** [SPEC-token-info-universal-ledger-v1.md](./SPEC-token-info-universal-ledger-v1.md) (PR #91: the `token_info_detect` ledger is already built — `db/init/42`, `src/strategies/token-info-detect.ts`). This SPEC adds a sibling insert-only table, it does not change the ledger.  
**Wayfinder:** [map #140](https://github.com/studentofcoding/reloadsol/issues/140) (paper-trading evidence architecture).

## Goal

A verdict on "was this a good entry?" needs the world as it was at the first detect. Three of the inputs are
overwritten or pruned afterwards: `token_mcap_tracking` is mutable, Jupiter's price is live-only, and
`token_ohlc_bars` keeps a rolling 48 h. This freezes them **once per mint** into `token_entry_context`.

## What a row holds

| Column(s) | Source | Cost |
|---|---|---|
| `detected_at`, `detecting_strategy`, `source` | the same seam call that writes `token_info_detect` | none |
| `tracker_first_mcap`, `tracker_current_mcap`, `tracker_first_seen_at`, `tracker_label`, `tracker_status` | `token_mcap_tracking` (one indexed read) | DB read |
| `jup_mcap`, `jup_usd_price`, `jup_volume_5m`, `jup_fetched_at`, `jup_status` | `fetchJupiterMarketHints` (shared L1/L2 cache + paced queue; 4 s timeout) | ≤ 1 queued Jupiter call, first detect only |
| `token_info` (+ `token_info_status`) | **copied from `token_info_detect`** when that row exists | DB read — **no GMGN call** |
| `pre_entry_bars` (`t,o,h,l,c,v`, oldest first), `pre_entry_bars_n`, `pre_entry_last_bar_at` | last N (default 30) 1m bars of `token_ohlc_bars` strictly before `detected_at` | DB read |
| `capture_lag_ms` | freeze time − detect time | none |

Each part that fails is recorded as a status (`error` / `unavailable` / `timeout` / `absent`) instead of blocking the
freeze: the row is write-once, so waiting or retrying would freeze a different moment.

## GMGN rate limits

The freeze makes **zero** GMGN calls. The Token Info tiles are whatever `captureTokenInfoDetectBatch` just wrote to
`token_info_detect` (which already goes through the single GMGN web/OpenAPI gate); the freeze runs *after* that
capture and only reads the row. If the GMGN gate deferred the capture, `token_info_status = 'absent'` and the tiles
stay joinable later through `(chain, token_address)` — nothing is re-fetched.

## Immutability

- One row per `(chain, token_address)`; `INSERT … ON CONFLICT DO NOTHING`.
- A `BEFORE UPDATE OR DELETE` trigger raises. Operator escape hatch for a deliberate delete:
  `BEGIN; SET LOCAL reloadsol.allow_entry_context_delete = 'on'; DELETE …; COMMIT;`.
- First writer wins. A cheap existence check runs before any upstream work, plus an in-process in-flight set, so a
  second strategy detecting the same mint adds no Jupiter or bar work.

## Wiring

`captureTokenInfoDetectBatch` (called by the GMGN pipeline, mcap/social sim-track routes and the trending cycle)
calls `freezeEntryContext` for each Sol mint after the Token Info capture, whether or not that capture succeeded.
`freezeEntryContext` never rejects. The hook is in the existing seam so no route file changes.

## Flags

| Env | Default | Meaning |
|---|---|---|
| `ENTRY_CONTEXT_FREEZE` | off (`1` to enable) | master switch; off = no query at all |
| `ENTRY_CONTEXT_JUPITER` | on (`off` disables) | skip the Jupiter hint (`jup_status='disabled'`) |
| `ENTRY_CONTEXT_JUPITER_TIMEOUT_MS` | 4000 | give up waiting on the shared Jupiter queue |
| `ENTRY_CONTEXT_BARS` | 30 (max 240) | pre-entry 1m bars to freeze |

## Ship order

1. Apply `db/init/64-token-entry-context.sql` (additive, idempotent) **before** the code.
2. Deploy. Nothing happens until `ENTRY_CONTEXT_FREEZE=1`.
3. Set `ENTRY_CONTEXT_FREEZE=1`; verify with `SELECT count(*), max(capture_lag_ms), count(*) FILTER (WHERE jup_status<>'ok') FROM token_entry_context;`.

The bar archive ([SPEC-evidence-bar-archive-v1.md](./SPEC-evidence-bar-archive-v1.md)) lists `token_entry_context` as an optional dataset, so it is exported to R2 once the table exists.

## Known limits

- Tiles are null when the first detect raced the GMGN gate; join to `token_info_detect` later.
- Jupiter hints are the 0.3 rps keyless shared queue: under load `jup_status='timeout'` rows are expected. The tracker mcap is the fallback.
- Only Sol mints; Robinhood is out of scope.
- No backfill: rows exist only from the moment the flag is on.
