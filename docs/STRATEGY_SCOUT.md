# Scout strategies: buy_bulk vs rh-tape

Two **separate** data-public scout strategies. They do not share config, notch
store, routes, or strategy ids.

| | buy_bulk (this repo) | rh-tape (already shipped) |
|---|---|---|
| **Strategy id** | `buybulk-datapublic-scout` | `rhtape-datapublic-scout` |
| **Surface** | `/dev/insight` (per-network scout) + `GET /api/scout/data-public?chain=robinhood\|solana` | Worker UI [rh-tape-bot `?v=3`](https://rh-tape-bot.yonathanevanchristy.workers.dev/?v=3) — **other repo / other agent** |
| **Notch store** | Postgres `strategy_paper_notches` (`strategy_id` CHECK = `buybulk-datapublic-scout`); localStorage cache only | rh-tape's own store — do not reuse |
| **Routes** | `/api/scout/data-public` + `/api/scout/data-public/paper` | rh-tape routes — do not reuse |
| **Live exec** | Never | rh-tape `processFill` — **do not couple** |

Implementation notes for buy_bulk: [DATA_PUBLIC_SCOUT.md](./DATA_PUBLIC_SCOUT.md).
Constants: `BUYBULK_DATAPUBLIC_SCOUT_ID` / `RHTAPE_DATAPUBLIC_SCOUT_ID` in
[`src/utils/data-public-scout.ts`](../src/utils/data-public-scout.ts).

## Hard boundaries (buy_bulk)

- **Never** call `executeBulkBuy` or a live swap from this path.
- **Never** enable `CLIMATE_GATE_LIVE` from this path.
- **Never** couple to rh-tape `processFill`, rh-tape Worker, or
  `rhtape-datapublic-scout` config / notches / routes.
- Not a shared strategy: do not register this id on rh-tape, and do not import
  rh-tape scout code into buy_bulk.

## Climate (buy_bulk)

Uses the Header **display** mapping (`fetchClimate` → `toClimateChipPayload`),
enforced **server-side** on `POST /api/scout/data-public/paper`. The chip UI
is still display-only for live trade controls.

| Label | Behavior |
|---|---|
| **Safe** (Mixed / Range / Hype, no cascade) | Observe list + paper notches allowed |
| **Not safe** or **Unknown** | Observe list only — Paper note disabled |

Live trade controls stay ungated by this strip.

## Chains (same mode)

Robinhood and Solana use the **same** filters and the same paper gate. Sol
feed delay ≥15 minutes is a **staleness note only** — it does not change
filters, paper rules, or become a live-exec exception.

## Persistence (buy_bulk)

Paper notes live in Postgres table `strategy_paper_notches` (migration
[`db/init/31-buybulk-datapublic-scout-notches.sql`](../db/init/31-buybulk-datapublic-scout-notches.sql)).
This follows `strategy_review_notes`: a dedicated additive table, **not**
`trading_records` sim buys (would pollute PnL) and **not** `strategy_outcomes`
(reports/ML). The CHECK constraint stamps `strategy_id = buybulk-datapublic-scout`
so rh-tape cannot share the store.

On an existing VPS volume (Docker init scripts only run on first start):

```bash
docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < db/init/31-buybulk-datapublic-scout-notches.sql
# or: bash scripts/deploy-tencent.sh schema
```

Fresh `docker compose up` applies `db/init/*.sql` automatically. Do not merge-deploy
from this agent; parent applies after merge.

## Out of scope

- **rh-tape-bot-cf** (Worker at `https://rh-tape-bot.yonathanevanchristy.workers.dev/?v=3`). Wire that surface in a separate PR/agent. This reloadsol PR must not change that repo.
- `CLIMATE_GATE_LIVE`
- Terminal `/api/chain-volume`
- Production deploy (VPS Docker — user / parent only)
