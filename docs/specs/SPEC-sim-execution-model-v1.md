# SPEC — realistic execution (slippage, impact, fees) + standardized PnL

Status: implementing (v1)
Owner: strategy sims (`mcap_enter_*`, `search_mcap_*`, `att_rh`, `gmgn_*`, `social_*`)

## Problem

Every paper strategy assumes **perfect fills at the spot price**, on both sides. Measured in the
current writers:

- `computeMcapSimPnlPct(entryMcap, exitMcap)` = `(exit − entry) / entry × 100` — a raw price ratio,
  used by the mcap sim, the signals sim and the exit replay.
- The Robinhood sim fills at spot: `tokenAmount = (nativeAmount × nativeUsd) / priceUsd`, and exits at
  `gainPct = (price − entryPriceUsd) / entryPriceUsd × 100`.

So a position that round-trips at the same price reports **0%** — no spread, no pool impact, no DEX
fee, no priority fee. That flatters short-hold, high-turnover strategies specifically (they pay the
round-trip cost many times), and it makes cross-strategy PnL comparisons meaningless, because each
writer has its own idea of what a fill is.

## Goal

1. One **execution model** that turns (side, notional, spot, depth, params) into a fill.
2. Every sim entry and exit goes through it, in real time, at the moment of the simulated trade.
3. **One standardized PnL formula** derived from those fills, so `pnl_pct` / `pnl_sol` mean the same
   thing in every strategy and can be recomputed from the stored row.
4. Honest labelling: a fill computed from an *assumed* depth is marked as such.

## Formulas (v1)

Constant-product AMM, which is what these tokens actually trade on. For a pool with quote reserve
`D` and trade notional `N` (both in the chain's native quote unit — SOL for `sol`, ETH for
`robinhood`), the **average execution price** of a swap is exactly
`spot × (1 ± N/D)`: the trade moves the marginal price by `N/(D+N)` and the average lands at
`N/D` for small `N`. So:

```
impact      = k × (N / D)^p            # k = impactCoeff (default 1), p = impactExponent (default 1)
fee         = f × notional             # f = feeBps / 1e4  (DEX/LP fee)
spread      = s × spot                 # s = spreadBps / 1e4 (latency/MEV allowance; no order book)
```

**Buy** (pay `N`, receive tokens):

```
effectivePrice = spot × (1 + impact + s)
tokensOut      = N × (1 − f) / effectivePrice
costQuote      = N + fixedCostQuote          # fixedCostQuote = priority fee + tip, per side
```

**Sell** (give tokens, receive quote):

```
exitNotional   = tokens × spot               # the depth consumed is the exit's own size
effectivePrice = spot × (1 − impact(exitNotional) − s)
proceedsQuote  = tokens × effectivePrice × (1 − f) − fixedCostQuote
```

**Standardized PnL** (the contract every writer must use):

```
costQuote   = entry.costQuote                # includes entry fee, impact, fixed cost
proceeds    = exit.proceedsQuote             # net of exit fee, impact, fixed cost
pnlQuote    = proceeds − costQuote
pnlPct      = pnlQuote / costQuote × 100
```

Both directions pay the model, so a round trip at an unchanged price is a **loss** — that is the
property the old formula could not express.

## Depth (`D`) — the input that decides the quality of all this

Preference order, recorded per fill as `depthSource`:

1. `liquidity` — pool quote liquidity from the token snapshot (GMGN/DexScreener), when present.
2. `volume_proxy` — `volume_24h / 24` as a crude stand-in, clearly labelled.
3. `assumed` — env `SIM_ASSUMED_DEPTH_QUOTE` (default 30), used when nothing is known. Rows carrying
   an assumed depth must be filterable, so a strategy cannot quietly win on imaginary liquidity.

## Params (env-tunable, all with sane defaults)

| env | default | meaning |
| --- | --- | --- |
| `SIM_FEE_BPS` | 100 (1%) | DEX/LP fee per side |
| `SIM_SPREAD_BPS` | 50 (0.5%) | spread/latency allowance per side |
| `SIM_PRIORITY_FEE_QUOTE` | 0.002 | fixed cost per side (priority + tip), native unit |
| `SIM_IMPACT_COEFF` | 1 | impact multiplier |
| `SIM_IMPACT_EXPONENT` | 1 | 1 = exact CPMM average-price impact |
| `SIM_ASSUMED_DEPTH_QUOTE` | 30 | depth when the snapshot has none |
| `SIM_EXECUTION_MODEL` | `on` | set `off` to keep the legacy spot-fill behaviour |

## Storage / standardization contract

Each outcome row keeps `pnl_pct` as the metric, but now derived from stored fills, under
`features.exec`:

```json
{
  "model": "exec-v1",
  "params": { "feeBps": 100, "spreadBps": 50, "priorityFeeQuote": 0.002, "impactCoeff": 1, "impactExponent": 1 },
  "entry": { "side": "buy", "spotPrice": 0.0001, "notionalQuote": 0.05, "effectivePrice": 0.0001051,
             "impactBps": 400, "spreadBps": 50, "feeQuote": 0.0005, "depthQuote": 12.5, "depthSource": "liquidity" },
  "exit":  { "side": "sell", "...": "same shape" },
  "pnlQuote": -0.0034
}
```

Rules:

- `features.exec.model` names the version; rows without it are legacy spot-fill rows (never
  re-labelled, never silently mixed in a comparison without saying so).
- A row's PnL must be recomputable from `features.exec` alone.
- Timestamps stay as they are; this is not a backfill. Historical rows stay as they were measured —
  the point is that going forward, and in every comparison, the model version is visible.

## Verification

1. Unit tests on the pure model, including the CPMM identity (`impact == N/D` when k=p=1) and the
   round-trip-is-a-loss property.
2. Live: recompute a sample of recent real sim trades under the model and report the drag
   (slippage + fee) in bps, per strategy.
3. The sims' own outcome rows must carry `features.exec` with `model: exec-v1` after the change.

## Non-goals (v1)

- No historical backfill (would fabricate a fill history the sims never had).
- No order-book depth reconstruction; the model is AMM-shaped by design.
- No change to real-trade execution (`swap-executor` is untouched) — this only fixes what the paper
  strategies *believe* they earned.
