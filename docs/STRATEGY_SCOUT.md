# Scout strategies: buy_bulk vs rh-tape

Two **separate** data-public scout strategies. They do not share config, notch
store, routes, or strategy ids.

| | buy_bulk (this repo) | rh-tape (already shipped) |
|---|---|---|
| **Strategy id** | `buybulk-datapublic-scout` | `rhtape-datapublic-scout` |
| **Surface** | `/buy` observe strip + `GET /api/scout/data-public` | Worker UI [rh-tape-bot `?v=3`](https://rh-tape-bot.yonathanevanchristy.workers.dev/?v=3) — **other repo / other agent** |
| **Notch store** | `localStorage` key `reloadsol:buybulk-datapublic-scout:paper-notches` | rh-tape's own store — do not reuse |
| **Routes** | `/api/scout/data-public` only | rh-tape routes — do not reuse |
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

Uses the Header **display** label (`GET /api/regime/climate`), not the DLMM
`CLIMATE_GATE` policy.

| Label | Behavior |
|---|---|
| **Safe** (Mixed / Range / Hype, no cascade) | Observe list + paper notches allowed |
| **Not safe** or **Unknown** | Observe list only — Paper note disabled |

Live trade controls stay ungated by this strip.

## Chains (same mode)

Robinhood and Solana use the **same** filters and the same paper gate. Sol
feed delay ≥15 minutes is a **staleness note only** — it does not change
filters, paper rules, or become a live-exec exception.

## Out of scope

- **rh-tape-bot-cf** (Worker at `https://rh-tape-bot.yonathanevanchristy.workers.dev/?v=3`). Wire that surface in a separate PR/agent. This reloadsol PR must not change that repo.
- `CLIMATE_GATE_LIVE`
- Terminal `/api/chain-volume`
- Production deploy (VPS Docker — user / parent only)
