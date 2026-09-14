# data-public scout + paper-sim (S6)

Primary surface is **`/dev/insight`**. Strategy id **`buybulk-datapublic-scout`**.
Same paper mode on Robinhood and Solana. **Never** calls `executeBulkBuy` or a
live swap from this path.

Identity and hard boundaries vs rh-tape (`rhtape-datapublic-scout`):
[STRATEGY_SCOUT.md](./STRATEGY_SCOUT.md). These strategies do **not** share
config, notch store, routes, or ids.

## Surfaces

| Surface | Role |
|---|---|
| `GET /api/scout/data-public?chain=all\|robinhood\|solana` | BFF: proxies `https://data-public.vercel.app/api/feed`, applies filters, attaches `climateAtEmit`. Insight uses `chain=robinhood` or `chain=solana` from AppNetwork (`sol` → `solana`). `chain=all` remains for tests / other callers. |
| `GET` / `POST /api/scout/data-public/paper` | Durable paper notes in Postgres (`strategy_paper_notches`). POST re-checks climate **on the server** |
| `/dev/insight` | Per-network scout home. RH context → RH scout. Sol context → Sol scout + **Roster digger (Sol)** (`RosterTab` / `/api/gmgn/roster`). |
| `/buy` | Thin link to `/dev/insight` for dev wallets. Scout is no longer the buy-page primary UX. |
| **Paper note** | DB row stamped `buybulk-datapublic-scout`. localStorage is a cache only. No fills, no sim-track open, no live exec |
| Climate chip on insight | Binary label **Safe** / **Not safe** / **Unknown** (no `Climate ` prefix). Regime detail beside/under it, e.g. `De-risk · H 0.5` (state + live `@sfinterface/numbers` H, one decimal). Same pattern when Safe/Unknown. Header chip stays display-only. |

Climate mapping is unchanged: Safe = Mixed/Range/Hype and no cascade; Not safe /
Unknown → list still visible, Paper note disabled. The write path calls
`fetchClimate` itself and returns 403 when the display label is not Safe.

## Per-network

`InsightPageClient` follows `useAppNetwork()`. Sol/RH tabs call `setNetwork`, so
scout rows and roster stay in the same network context — they are not mashed
into one undifferentiated list.

- **Robinhood:** RH scout only. Does not embed Sol roster digger as primary.
- **Solana:** Sol scout + Roster digger (Sol). Link through to `/dev/signals?tab=roster`.

## Persistence

Source of truth: `strategy_paper_notches` (see [STRATEGY_SCOUT.md](./STRATEGY_SCOUT.md)).
Apply on existing VPS:

```bash
docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < db/init/31-buybulk-datapublic-scout-notches.sql
```

## Filters (both chains)

Applied before a row is shown as an actionable paper candidate:

1. Prefer `decision=surfaced` and run/revival kinds (`rhrun`, `rhrevival`, `*run`, `*revival`).
2. Non-empty / critical veto lists fail. Empty `[]` passes. Missing vetoes on runs/revivals do not fail.
3. Liquidity floor ~$9k when `liq` is present.
4. Skip obvious ring / fresh / copycat **when those fields are present** (`evmBundle.verdict=ring`, fresh ratio ≥ 50%, high `nameReuse` / `imageReuse` / registry priors).
5. Dedupe by `(chain, mint)`.

Sol rows are delayed ≥15 minutes (`solDelayMin` from the feed). The Sol scout shows a staleness note.

## Out of scope

- Live `executeBulkBuy` / live swap from this feed
- rh-tape-bot-cf / Worker / `processFill` / `rhtape-datapublic-scout` (separate agent)
- Enabling `CLIMATE_GATE_LIVE`
- Terminal `/api/chain-volume`
- Production deploy (VPS Docker — user / parent only)

## Disclaimer

The public feed is **study / research** only. The scout list repeats that ToS.

## Manual verify

1. `npm test -- src/utils/climateDisplay.test.ts src/utils/data-public-scout.test.ts src/utils/paper-notch-store.test.ts src/app/api/scout/data-public/route.test.ts src/app/api/scout/data-public/paper/route.test.ts src/strategies/buybulk-datapublic-scout-notches.test.ts src/config/route-network.test.ts`
2. `npm run dev` → open `/dev/insight` on Sol and on Robinhood (header network toggle or in-page Sol/RH tabs).
3. Confirm climate chip shows **Not safe** / **Safe** / **Unknown** (no `Climate ` prefix) plus regime detail like `De-risk · H 0.5`. **H**, scout **score**, **liq**, **mcap**, chain count, and paper-note scores use `@sfinterface/numbers` (they roll when the poll updates).
4. Sol: Sol scout list + **Roster digger (Sol)**. RH: RH scout only; roster is not the primary panel.
5. `/buy` shows a thin link to `/dev/insight` for dev wallets, not the full observe strip.
6. With Header climate **Safe**: **Paper note** POSTs `/api/scout/data-public/paper`, row appears in `strategy_paper_notches`; no wallet prompt / no swap.
7. Force Not safe / Unknown: list still visible; Paper note is disabled; POST returns 403 and inserts nothing.
8. Network tab: client hits `/api/scout/data-public?chain=solana` or `chain=robinhood` (not an unscoped mash) and `/api/scout/data-public/paper` only. No `/api/buy` or swap routes from the scout list.
