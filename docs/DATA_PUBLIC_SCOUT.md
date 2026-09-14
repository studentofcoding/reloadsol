# data-public observe + paper-sim (S6)

Buy-bulk **observe strip** for the public research feed. Same mode on Robinhood
and Solana. **Never** calls `executeBulkBuy` or a live swap from this path.

## Surfaces

| Surface | Role |
|---|---|
| `GET /api/scout/data-public?chain=all\|robinhood\|solana` | BFF: proxies `https://data-public.vercel.app/api/feed`, applies filters, attaches `climateAtEmit` |
| Observe strip on `/buy` (`BulkTokenBuyer`) | Lists filtered RH + Sol candidates (tabs + chain badge) |
| **Paper note** | Local paper-interest notch (`localStorage`). No fills, no sim-track open, no live exec |
| Header climate chip | Display-only. Paper notes from *this* feed require binary label **Safe** |

Climate mapping is unchanged: Safe = Mixed/Range/Hype and no cascade; Not safe /
Unknown → strip stays visible, Paper note disabled with a tip.

## Filters (both chains)

Applied before a row is shown as an actionable paper candidate:

1. Prefer `decision=surfaced` and run/revival kinds (`rhrun`, `rhrevival`, `*run`, `*revival`).
2. Non-empty / critical veto lists fail. Empty `[]` passes. Missing vetoes on runs/revivals do not fail.
3. Liquidity floor ~$9k when `liq` is present.
4. Skip obvious ring / fresh / copycat **when those fields are present** (`evmBundle.verdict=ring`, fresh ratio ≥ 50%, high `nameReuse` / `imageReuse` / registry priors).
5. Dedupe by `(chain, mint)`.

Sol rows are delayed ≥15 minutes (`solDelayMin` from the feed). The strip shows a staleness note.

## Out of scope

- Live `executeBulkBuy` / live swap from this feed
- rh-tape Worker changes
- Enabling `CLIMATE_GATE_LIVE`
- Terminal `/api/chain-volume`
- Production deploy

## Disclaimer

The public feed is **study / research** only. The strip repeats that ToS next to the list.

## Manual verify

1. `npm test -- src/utils/data-public-scout.test.ts src/utils/paper-notch-store.test.ts src/app/api/scout/data-public/route.test.ts`
2. `npm run dev` → open `/buy/solana` and `/buy/robinhood`.
3. Confirm the **Observe · data-public** strip lists RH and/or Sol rows (tabs or combined with badge).
4. Confirm the study/research disclaimer and Sol ≥15m delay note are visible.
5. With Header climate **Safe**: **Paper note** records a local notch; no wallet prompt / no swap.
6. Force Not safe / Unknown (stale climate or Cash upstream): strip still lists rows; Paper note is disabled with the tip.
7. Network tab: client only hits `/api/scout/data-public` (not `data-public.vercel.app` directly). No `/api/buy` or swap routes from the strip.
