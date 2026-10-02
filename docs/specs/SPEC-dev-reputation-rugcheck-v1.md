# SPEC — Dev reputation lists + RugCheck risk features v1

**Status:** Shipped, **shadow-first** (nothing enforced). Prod flags on, `DEV_REPUTATION_MODE=shadow`.
**Date:** 2026-09-30
**Plan:** `~/.commandcode/plans/dev-reputation-and-rugcheck-v1.md`
**Related:** [SPEC-token-info-universal-ledger-v1.md](./SPEC-token-info-universal-ledger-v1.md) (the Freeview nine-tile ledger this joins at the capture seam), [SPEC-gmgn-web-multi-token-info-v1.md](./SPEC-gmgn-web-multi-token-info-v1.md) (`GMGN_TOKEN_INFO_SOURCE=web`), `strategies/RUG_SIGNAL.md` + `src/strategies/ohlc-rug-rules.ts` (the price-action rug engine this adds an on-chain axis to).

## Goal

Two capabilities on the existing rug/gate spine, **shadow-first** — they record and display a
verdict but change no trading behaviour until the correlation data shows an effect:

1. **Dev ban / profitable-dev lists** — score a token's creator from GMGN `created_tokens`
   (graduation rate + per-coin ATH), persist per creator, and surface it.
2. **RugCheck risk features** — free/keyless per-token on-chain risk (score, named risks, insider
   graph, LP lock, creator balance) added to the rug-probability picture.

The verdict is rendered as a **label on every surface we already have**, suffixed `(shadow)`.

## Locked decisions (do not reopen)

| Lock | Value |
|------|--------|
| Dev history source | **GMGN `GET /v1/user/created_tokens`** is the only creator-history source in the stack (exist-auth, weight 2). Jupiter gives the dev *address* only; RugCheck has **no** creator-history endpoint and `creatorTokens` is `null` in practice |
| Scoring input | Aggregate counts, never the `tokens[]` length — total created = `inner_count + open_count`; the array caps at 100 |
| RugCheck shape | `score` is a raw weighted sum; `score_normalised` is 0–100 (**higher = riskier**). Empty `risks[]` = **unknown, never a bonus** |
| Creator resolution | GMGN `info.dev.creator_address` → **RugCheck `creator`** (free, already fetched) → Jupiter `dev` (last resort) |
| Ban floor | `sample < DEV_MIN_SAMPLE` (5) → `inconclusive`, so a 1-coin dev can never ban |
| Enforcement | **Off.** `DEV_REPUTATION_MODE=enforce` alone is not enough — the correlation must first be significant |
| Rate posture | RugCheck capped at **3 rps** (≈30% of the measured ~10 rps clean ceiling); dev lookups cached 24h/creator with a 60s GMGN backoff |

## As-built

| Piece | Where | What it does |
|-------|-------|--------------|
| RugCheck features (pure) | `src/strategies/rugcheck-features.ts` | `mapRugcheckReport` → `RugcheckFeatures` (`scoreNormalised`, `riskNames`, `riskPoints`, `creator`, `creatorBalance`, `graphInsidersDetected`, `lpLockedPct`, `mutableMetadata`, `rugged`) |
| RugCheck client | `src/utils/rugcheck-api.ts` | Keyless `GET /v1/tokens/{id}/report`; timeout + soft-fail → `null`; serial min-interval gate `RUGCHECK_MAX_REQ_PER_SEC` (default 3) |
| Dev scorer (pure) | `src/strategies/dev-reputation.ts` | `scoreDevReputation` → `ban`/`good`/`inconclusive`; `topDevTokens` → top-10 by ATH |
| Dev data | `src/utils/dev-reputation-data.ts` | `resolveCreatorAddress` (3-source order above); `fetchDevReputation` (GMGN + 24h redis cache + 60s RATE_LIMIT backoff) |
| Shadow writer | `src/strategies/risk-store.ts` | `attachRiskShadow` — RugCheck + dev, compose the label, best-effort persist to `token_risk_features` + `dev_reputation`; **never** changes `pass`/`banned` |
| Background queue | `src/strategies/risk-shadow-queue.ts` | Deduped, bounded (300), single-drain, fire-and-forget so the hot path never blocks |
| Capture hook | `src/strategies/token-info-detect.ts` | Enqueues **every** sol token up front (skips `gmgn_pipeline`, which attaches inline) — **before** the GMGN panel lookup, so RugCheck still runs when GMGN is rate-limited |
| GMGN wrapper | `src/utils/gmgn-api.ts` | `createdTokens()`; timestamp/signature are stamped **after** the rate gate (GMGN 401s a >~20s-old timestamp) |
| Label contract | `src/strategies/risk-label.ts` | One `RiskLabel`; `(shadow)` suffix on every rendered line |

### Persistence

- `db/init/48-dev-reputation-and-risk.sql` — `token_risk_features` (chain, token_address) and
  `dev_reputation` (chain, creator_address). Both `CREATE TABLE IF NOT EXISTS`; the runtime ensure in
  `risk-store.ts` mirrors them.
- `db/init/49-dev-reputation-tokens.sql` — adds `dev_reputation.tokens jsonb` (top ≤10 by ATH),
  mirrored as a runtime `ALTER … ADD COLUMN IF NOT EXISTS`.
- `db/init/53-dev-user-rugs.sql` — adds `dev_reputation.user_rug_count` + `user_rug_tokens` (user-labelled
  rugs, mirroring `tokens`), also mirrored at runtime. Written by `recordUserRug`/`clearUserRug`
  (`risk-store.ts`) from the single rug write path (`markTokenRug`/`unmarkTokenRug`, user sources only)
  and shown on `/dev/dev-reputation`. **Not an input to `scoreDevReputation` yet** — display-only, like
  the rest of the shadow posture.
- Both applied to prod; additive and idempotent.

### Env flags (default off, shadow)

`RUGCHECK_ENABLED`, `DEV_REPUTATION_ENABLED`, `DEV_REPUTATION_MODE=shadow|enforce`,
`DEV_REPUTATION_KILL_SWITCH`, `RUGCHECK_MAX_REQ_PER_SEC` (3), `RUGCHECK_TTL_S` (900),
`DEV_REPUTATION_TTL_S` (86400), `DEV_MIN_SAMPLE` (5), `DEV_BAN_MAX_GRADUATION` (0.05),
`DEV_GOOD_MIN_GRADUATION` (0.25), `DEV_GOOD_MIN_ATH_MC` (1e6).

## Surfaces (the "show on all layers" requirement)

| Surface | Where |
|---------|-------|
| Freeview tiles chip | `GET /api/gmgn/token-snapshot` → `GmgnTokenStatsGrid` |
| OHLC/rug panel chip | `GET /api/gmgn/detect-snapshot` → `OhlcRugPanel` |
| Tracker rows / Signals rows | `useRiskChips` + `RiskChip`, fed by **`GET /api/gmgn/risk-chips`** (bulk, one query) |
| Sim-open toasts | `/api/mcap-tracking/sim-open-alerts` enriches items → `McapTrackerToasts` |
| Radar Telegram | pipeline folds `riskLabelLines` into the radar summary |
| Data layer | `entryFeatures` (`risk_verdict`, `risk_rugcheck_score_norm`, `risk_reasons`, …) on GMGN opens |
| Dev lists UI | **`/dev/dev-reputation`** — Profitable devs / Ban list, per-dev stats + inline top-5 + expandable top-10 token table |

## Evidence (measured 2026-09-30, prod)

Shadow rows: 8 → **123** once the capture path was unblocked; `dev_reputation` 51 rows, **48 with
tokens** (after `scripts/backfill-dev-tokens.mjs`).

Correlation (`scripts/rugcheck-correlation.mjs`, n=16 joined outcomes):

| Bucket | n | win% | median PnL |
|---|---|---|---|
| rugcheck 0–10 | 15 | 86.7% | +1172% |
| rugcheck 60+ | 1 | 0% | −53% |
| dev ban | 5 | 100% | +1172% |
| dev good | 1 | 0% | −53% |
| dev inconclusive | 4 | 75% | +1012% |
| dev unknown | 6 | 83.3% | +1076% |

**Every bucket is `inconclusive` (n < 20) → no evidence, stay in shadow.** The `ban` bucket
currently points the *opposite* way (5 trades) — noted, meaningless at that n.

## Open items

1. **Enforcement** (not enabled, correctly): `ban → markTokenRug` with a new `source: 'dev'`
   (`src/types/rug-list.ts` not extended yet); `good →` bonus points in potential scoring
   (`entry-ml-scorer` / `combined-score`). Nothing sizes.
2. **Soak** — the correlation needs volume before it can say anything; re-run and only then flip.
3. **Provider reality** (checked live 2026-09-30): **Axiom** cannot replace GMGN — it returns
   concentration/risk only, needs a graduated pool, and its route was returning **425 Too Early**
   on stale hardcoded cookies. **SolanaTracker** is out of credits
   (`{"error":"Insufficient credits for this request"}`). **SolSniffer** is key-gated (deferred).
   GMGN stays the only creator-history source.
4. **Deviations from the plan** (covered by other surfaces): no chip inside
   `tracker-insights.ts` (row chip instead); no write into `detect-snapshots.features` JSONB
   (the route returns `riskChip` instead).

## Verification

- Unit: `rugcheck-features.test.ts`, `dev-reputation.test.ts`, `risk-label.test.ts`,
  `risk-shadow-queue.test.ts`, `token-info-detect.test.ts` (decoupling pinned), `rugcheck-api.test.ts`.
- Gate: `npm test` (1939 passing) → `npm run lint` (0 errors) → `verify:no-raw-useeffect` →
  `npm run build` → `npm run start`.
- Live: `/dev/dev-reputation` 200; `/api/gmgn/risk-chips` returns red chips for known mints;
  `/api/dev/reputation` returns rows with tokens.
