# SPEC — Immutable Token Info universal ledger v1

**Status:** to-spec (docs only; HITL locks closed)  
**Date:** 2026-09-27  
**Related:** [SPEC-sol-first-spine-4class-ohlc-v1.md](../SPEC-sol-first-spine-4class-ohlc-v1.md) (complement; sleeve rug SoT stays concentration soft score; this ledger feeds that soft path), [SPEC-ohlc-rug-spine-v1.md](../SPEC-ohlc-rug-spine-v1.md) (`token_detect_snapshots` stays OHLC), [SPEC-rug-filter-v1.md](./SPEC-rug-filter-v1.md) (Bubblemaps + Jupiter organic — separate, out of scope here)  
**Wayfinder context (do not reopen):** [map #79](https://github.com/studentofcoding/reloadsol/issues/79), concentration soft vs hard ban [#86](https://github.com/studentofcoding/reloadsol/issues/86). No separate Token Info ledger ticket exists.

## Goal

When **any** strategy first detects a Sol token, freeze the Freeview Token Info nine-tile panel **once** into one shared Postgres ledger. Every strategy reads that row the same way for soft sizing, research, and later evaluation.

The detect row is immutable. Later observations may be appended as history. History never overwrites the detect row.

v1 does not add a hard stop from these tiles. The live concentration hard ban stays as it is today, outside this soft path.

## Locked decisions (do not reopen)

| Lock | Value |
|------|--------|
| Freeze clock | First detect by **any** strategy |
| What freezes | Full Token Info panel matching `GmgnTokenSnapshot` / Freeview tiles |
| Mutability | Detect snapshot is **write-once**. It is not an updatable “current” card |
| SoT | One universal ledger. Strategies do not keep private copies of these tiles |
| Use in v1 | **Soft only** — sizing, research, evaluate-later. No new hard stop from the nine fields |
| Hard ban | `CONCENTRATION_BAN_PCT` = **65** on Top 10 / Dev / Bundlers stays live and unchanged |
| History | Optional append-only observations with their own timestamps. Never `UPDATE` the detect row |
| Table | New table. Do not extend `token_detect_snapshots` |
| Clock column | `detected_at` on the new row. Do not reuse `token_mcap_tracking.first_seen_at` |
| Soft thresholds | **TBD** at evaluate-later. This SPEC sets none |

## As-built (verify before wiring)

These facts are the current code. The ledger does not exist yet.

| Fact | Where | What it is |
|------|--------|------------|
| Live Freeview panel | `GET /api/gmgn/token-snapshot` (`src/app/api/gmgn/token-snapshot/route.ts`) | Builds `GmgnTokenSnapshot` and returns it. Display-only concentration eval. Does **not** `markTokenRug` |
| Live cache | `src/utils/gmgn-snapshot-cache.ts` | Redis key `gmgn:token-snapshot:{chain}:{address}`, **TTL 10s**. Shared with the GMGN sim pipeline. Not a durable SoT |
| Snapshot shape | `src/strategies/gmgn-token-snapshot.ts` `GmgnTokenSnapshot` / `buildGmgnTokenSnapshot` | Nine tiles. Percents are already **0–100** (`asPercent`). Auth `true` means the authority is still active (not renounced) |
| Tile paint | `src/components/token-locate/GmgnTokenStatsGrid.tsx` | Labels below. Snipers falls back to wallet count when hold % is null. Dex tile label is `Dex`; value is `dexBoostLabel` |
| Hard ban | `src/strategies/concentration-ban.ts` | `CONCENTRATION_BAN_PCT = 65`. Ban when Top 10, Dev, or Bundlers is **strictly greater than** 65. `banConcentrationIfNeeded` calls `markTokenRug` and then best-effort OHLC capture |
| Ban call site | `gateGmgnCandidates` in `src/strategies/gmgn-pipeline.ts` | Live info/security in, ban decision out. The token-snapshot route only **displays** the same eval |
| OHLC detect table | `token_detect_snapshots` (`db/init/17-token-detect-snapshots.sql`, `src/strategies/detect-snapshots.ts`) | Last OHLC bars, features, rule hits, rug label. `source` is only `'concentration' \| 'freeview'`. No Token Info columns. No `chain` |
| Mcap clock | `token_mcap_tracking.first_seen_at` | **Mutable.** `normalizeTrackingTimeline` rewrites it to the earliest milestone (`src/utils/mcap-tracker.ts`). `resetTrackingSession` sets it to “now” and clears milestones. Not an immutable detect clock |

`dexBoostLabel` is a display string computed at build time (`formatDexBoost`, relative age such as `Boost 3h`). The frozen value is that string. Readers do not recompute it.

Route extras `holders`, `price_usd`, `isHoneypot`, `concentrationBanned`, and `concentrationReasons` are not part of `GmgnTokenSnapshot`. They are not ledger columns in v1.

## Persistence

Next numbered migration after `db/init/40-index-hygiene.sql`: **`db/init/41-token-info-detect.sql`**, applied by `scripts/init-local-db.sh` the same way as the other numbered files. This docs PR does not add that file.

Mirror `17-token-detect-snapshots.sql` for RLS: `ENABLE ROW LEVEL SECURITY`, no new policy.

### Detect table — `token_info_detect`

One immutable row per `(chain, token_address)`.

| Column | Type | Maps to |
|--------|------|---------|
| `id` | `UUID` PK default `gen_random_uuid()` | — |
| `chain` | `TEXT NOT NULL` | `GmgnTradeChain`: `sol` \| `robinhood`. v1 writers pass `sol` |
| `token_address` | `TEXT NOT NULL` | Mint string the detecting strategy already uses. Sol base58 is case-sensitive. Do not apply the Redis key’s `toLowerCase()` |
| `detected_at` | `TIMESTAMPTZ NOT NULL` | Freeze clock: time of the winning strategy detect. Not `first_seen_at` |
| `detecting_strategy` | `TEXT NOT NULL` | Strategy id that won the insert (`mcap_enter_first_seen`, `mcap_enter_at_80`, `social_only_fomo_gt7`, a GMGN id, a trending id, …) |
| `source` | `TEXT NOT NULL` | Seam family: `mcap_first_seen` \| `mcap_at_80` \| `social` \| `gmgn_pipeline` \| `trending` |
| `top10_hold_pct` | `DOUBLE PRECISION` null | `top10HoldPct` — tile **Top 10 H.** |
| `dev_hold_pct` | `DOUBLE PRECISION` null | `devHoldPct` — **Dev H.** |
| `snipers_hold_pct` | `DOUBLE PRECISION` null | `snipersHoldPct` — **Snipers H.** |
| `sniper_wallet_count` | `DOUBLE PRECISION` null | `sniperWalletCount` — Snipers tile fallback when hold % is null. On `GmgnTokenSnapshot`, so it freezes with the panel |
| `freeze_auth_active` | `BOOLEAN` null | `freezeAuthActive` — **Freeze Auth** (`Yes` / `No` / `—`) |
| `mint_auth_active` | `BOOLEAN` null | `mintAuthActive` — **Mint Auth** |
| `dex_boost_label` | `TEXT` null | `dexBoostLabel` — **Dex** / Dex boost. Frozen string, including the relative age baked in at capture |
| `pro_traders_pct` | `DOUBLE PRECISION` null | `proTradersPct` — **Pro Traders** |
| `insiders_hold_pct` | `DOUBLE PRECISION` null | `insidersHoldPct` — **Insiders H.** |
| `bundlers_hold_pct` | `DOUBLE PRECISION` null | `bundlersHoldPct` — **Bundlers H.** |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Insert time. May match `detected_at` |

Uniqueness: `UNIQUE (chain, token_address)`.

No `updated_at`. No snapshot-column `UPDATE`. No `ON CONFLICT DO UPDATE`.

Null tiles are valid. A panel with some nulls is still the official card. A later fetch that fills those nulls does **not** patch this row.

### Write rules

1. Build the panel with `buildGmgnTokenSnapshot(info, security)` from a payload that `getGmgnTokenSnapshotCached` would return (info or security non-empty).
2. Insert with `ON CONFLICT (chain, token_address) DO NOTHING`, then read the existing row if this insert did not win.
3. Both objects empty, or the cache returns undefined: **do not insert**. A later seam may still be the first writer.
4. Concurrent losers are dropped. Do not copy the losing payload into history from the conflict handler.
5. Capture is best-effort. A DB error logs and leaves the strategy tick running. A missing row is not a hard skip.
6. There is one writer helper. Seams call it. They do not `INSERT` on their own.

`detected_at` is the seam’s detect time (the tick that selected the mint). When the seam has no earlier event timestamp, use the insert time. Never copy `token_mcap_tracking.first_seen_at`.

### History — `token_info_detect_history` (optional, separate)

DDL may ship in the same migration so nobody “updates the card” for lack of a place to put a later observation. No history writer is required to finish capture.

Append-only. Suggested columns: `id`, `chain`, `token_address`, `observed_at`, `observing_strategy`, `source`, the same snapshot columns, `created_at`.

- Foreign key `(chain, token_address)` → `token_info_detect`, `ON DELETE RESTRICT`.
- Index `(chain, token_address, observed_at DESC)`.
- No unique constraint that collapses observations.
- `INSERT` only. No update of the parent row.
- v1 capture does not write history.

Name is a suggestion. A different name is fine if the parent row stays immutable.

## Capture trigger

Clock = the first **strategy** detect that successfully freezes a panel. Whichever wired seam inserts first wins.

`trackTokenMcap` / “New Token Tracked” is mcap bookkeeping, not this clock. Freeview `GET /api/gmgn/token-snapshot` is a live display route, not a writer.

Capture when the seam has selected the mint as a candidate (assigned, gated, eligible, or entering the entry template), including when a later gate skips the open. Freeze the card even if the strategy does not buy.

| Seam | `source` | Where to call the helper later | Strategy id examples |
|------|----------|--------------------------------|----------------------|
| Mcap first-seen | `mcap_first_seen` | `src/app/api/mcap-tracking/sim-track/route.ts` when `entryTemplate === 'first_seen'` (worker `mcap_tracker_sim_open`) | `mcap_enter_first_seen` |
| Mcap @80 | `mcap_at_80` | Same route when `entryTemplate === 'milestone_80'` | `mcap_enter_at_80` |
| Social | `social` | `src/app/api/social/sim-track/route.ts` on eligible candidates (`src/strategies/social/social-only-discovery.ts`) | `social_only_fomo_gt7` |
| GMGN pipeline | `gmgn_pipeline` | `gateGmgnCandidates` in `src/strategies/gmgn-pipeline.ts` (caller `src/app/api/gmgn/sim-track/route.ts`), beside the existing snapshot fetch | `gmgn_smartmoney_default`, `gmgn_kol_momentum`, `gmgn_sm_kol_combined` |
| Trending | `trending` | `src/strategies/trending-track/cycle.ts` when `assignTokenToStrategy` assigns the mint | assigned trending strategy id |

Seam order is **TBD**. The helper lands before any seam. Until every row in the table calls it, “first detect” means first among **wired** seams. The implementation is complete when all five Sol seams call the helper.

On the GMGN seam the ban decision keeps using the live snapshot already in hand. Capture is a second call next to that, not a branch inside `evaluateConcentrationBan`.

v1 writers pass `chain = 'sol'`. Robinhood twins (`mcap_enter_*_rh`, GMGN `discovery.chain === 'robinhood'`, trending RH) stay unwired (same post-Sol fog as the spine SPEC). The `chain` column is there so a later wire does not need a new table.

## Read contract

Strategies that need Token Info for soft rules or enrichment:

1. Load `token_info_detect` for `(chain, token_address)`.
2. When the row exists, use it for the nine tiles (and sniper count). Do not overlay a live GMGN refetch onto those fields.
3. When the row is absent, a live fetch is allowed. The detect seam that already holds info/security should try the write-once insert. Soft logic may use that in-tick payload only until the insert wins or the read returns the winner.
4. A missing row does not skip, ban, or size to zero.

The hard ban is the exception. `evaluateConcentrationBan` / `banConcentrationIfNeeded` keep comparing the **live** Top 10 / Dev / Bundlers to 65. They do not read this ledger.

`GET /api/gmgn/token-snapshot` and `GmgnTokenStatsGrid` stay the live Freeview display (Redis 10s). v1 does not switch that grid to the frozen card.

Suggested helper names (implementer may rename): `insertTokenInfoDetectIfAbsent`, `getTokenInfoDetect`. One module. Seams and soft readers use it.

## Soft use vs hard ban

| Path | v1 behavior |
|------|-------------|
| Soft sizing / research / later evaluation | May read the detect row. Numeric enlarge, shrink, and soft-zero cutoffs stay **TBD**. Do not invent them here or in the first code PR |
| Spine concentration soft score | Intended consumer of the frozen Top 10 / Dev / Bundlers (same three fields as the ban). Wiring is a later soft consumer. Sleeve math stays in [SPEC-sol-first-spine-4class-ohlc-v1.md](../SPEC-sol-first-spine-4class-ohlc-v1.md) |
| Other six tiles | Available on the row for future soft enrichment. No v1 rule |
| Hard ban | Unchanged. Live `> 65` on Top 10 / Dev / Bundlers, `markTokenRug({ source: 'concentration' })`, then best-effort **OHLC** `captureDetectSnapshot`. Not this table |

4-class growth labels, the OHLC second head, and the READY ladder are unchanged. This ledger does not become a growth4 feature unless a follow-on SPEC says so.

## Out of scope v1

- New hard bans, skips, or `markTokenRug` sources from the nine tiles
- `UPDATE` / upsert of the detect row, including “fill the nulls later”
- Pointing the hard ban at the ledger
- Putting Token Info columns on `token_detect_snapshots`
- Using `first_seen_at` as `detected_at`
- Growth4 / 4-class feature columns
- Bubblemaps and the Jupiter organic rug filter
- Robinhood capture (fog)
- Numeric soft thresholds
- Freeview UI reading the ledger instead of the live route
- Recomputing `dex_boost_label` on read
- A history writer (DDL may exist; append comes later)
- Signals-list, mcap heartbeat, and the token-snapshot route as capture writers

## Implementation order

1. **Schema.** `token_info_detect` plus optional empty `token_info_detect_history`. No application writer yet.
2. **Capture.** Write-once helper, then the five Sol seams in any order. Each seam calls the helper when it first selects the mint and a snapshot payload exists.
3. **Read helper.** Strategies that soft-read Token Info go through it and prefer the ledger when a row exists. Hard-ban call sites stay on the live eval.
4. **Soft consumers later.** Spine concentration soft score and other research. Thresholds stay TBD in the spine SPEC.

Do not start at step 4. Do not fold step 4’s thresholds into steps 1–3.

## Acceptance

Handoff (this PR):

- [ ] SPEC is in `docs/specs/` and linked from `docs/specs/README.md` and `docs/README.md`
- [ ] Spine SPEC and the OHLC / architecture notes point here so `token_detect_snapshots` is not the landing table
- [ ] No product TypeScript and no migration file in this PR

Implementation (later PR):

- [ ] `UNIQUE (chain, token_address)` and `ON CONFLICT DO NOTHING` — a second insert leaves the first snapshot bytes unchanged
- [ ] `detected_at` is the winning seam’s time and is not read from `first_seen_at`
- [ ] A failed or empty GMGN fetch does not occupy the unique key
- [ ] Null tiles stay null on the detect row
- [ ] All five Sol seams call the helper; a skipped open still freezes
- [ ] Soft readers with a row use the ledger and do not overlay live GMGN
- [ ] `banConcentrationIfNeeded` still bans on live `> 65` and still does not read this table
- [ ] No new hard stop from Freeze Auth, Mint Auth, Snipers, Dex boost, Pro Traders, Insiders, or the frozen concentration percents
- [ ] History, if written, is an insert with its own `observed_at` and does not change the detect row
- [ ] RH seams are not wired
- [ ] No new numeric soft threshold is committed

## Files

**This PR (docs only):**

- `docs/specs/SPEC-token-info-universal-ledger-v1.md`
- `docs/specs/README.md`
- `docs/README.md`
- `docs/SPEC-sol-first-spine-4class-ohlc-v1.md` (related link)
- `docs/SPEC-ohlc-rug-spine-v1.md` (OHLC table stays OHLC)
- `docs/architecture.md` (schema map)
- `docs/mcap-tracker.md` (`first_seen_at` is not this clock)

**Implementation PR (not this one):**

| File | Change |
|------|--------|
| `db/init/41-token-info-detect.sql` | Detect table + optional history DDL |
| New helper next to `src/strategies/` | Write-once insert + read. Only writer |
| `src/app/api/mcap-tracking/sim-track/route.ts` | First-seen and @80 seams |
| `src/app/api/social/sim-track/route.ts` | Social seam |
| `src/strategies/gmgn-pipeline.ts` | GMGN seam beside the live ban |
| `src/strategies/trending-track/cycle.ts` | Trending seam on assign |
| Tests | Conflict does not overwrite; empty fetch does not insert; ban still uses live percents |

Not expected to change in that PR: `evaluateConcentrationBan` thresholds, `token_detect_snapshots`, `GmgnTokenStatsGrid` data source, growth4 trainers, RH twins.
