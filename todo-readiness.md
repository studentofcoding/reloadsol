# Auto-trade readiness — checklist

`todo.md` is the Goldsky ledger rollout (with a backfill live), so this is a separate file to avoid
editing that workstream's checklist in place. Merge into `todo.md` when theirs is done.

**State today (verified on prod):** nothing is armed — `MCAP_LIVE_TRADING_ENABLED=false` (explicit),
all **26** `strategy_definitions` are `sim_only`, `EVAL_EXEC_MODE=paper`, `SIM_EXECUTION_MODEL` and
`JUP_QUOTE_SAMPLE_EVERY` unset. Trading wallet **0.1404 SOL**, which clears the 0.1 cap, so funding is no
longer the blocker.

---

## ☐ 1. Size the desk at a viable level — evidence before anything else

The cost model charges a **fixed ~0.00006 SOL per round trip** (priority 0.00003/side plus tx fees), so
that cost is ≤1% of a trade only at **≥0.006 SOL**. Measured mean sim size, last 3 days:

| strategy | positions | mean size | fixed cost |
| --- | --- | --- | --- |
| `att_rh` | 16,446 | 0.00150 SOL | **4.00%** |
| `search_mcap_…tp150 / tp200 / tp300` | 247 / 242 / 234 | 0.00328 – 0.00353 | 1.7 – 1.8% |
| `mcap_enter_first_seen` | 209 | 0.00402 | 1.5% |
| `mcap_enter_at_80` | 186 | 0.00441 | 1.4% |
| `gmgn_sm_kol_combined` | 56 | 0.00873 | 0.7% — and losing anyway |

- [ ] Raise the mcap/search base. **Decision: the regime keeps sizing every position** — every stake is
      its base x the brain's `sizeScale` (0.25 today, De-risk with a cascade veto), which is why the
      observed stake is ~0.001. Clearing the ~0.006 fixed-cost floor at the *current* climate needs a
      base of ~0.024 (≈6x), and in Hype (scale 1.0) that same base stakes four times as much — so this is
      a policy choice, not a constant to nudge.
- [ ] Change it where it lives: **local code for `search_mcap_*`** (no brain recipe exists for the family,
      so it takes the documented `keep local size` fallback) and the **recipe** for
      `mcap_enter_first_seen`. The amount reaches `openSimPosition` already sized
      (`stampBrainRisk(..., { sizedSol })`), i.e. the base is applied upstream in the sim-open path.
- [ ] Decide `att_rh` separately: 16,446 of ~17,700 positions at a **4.00%** fixed cost with a
      break-even median — it cannot be profitable with any positive fees. Size it up, or keep it as a
      data source and never arm it.
- [ ] Keep the two size inputs in agreement: `SIM_BASE_POSITION_SOL` / `SIM_DAILY_BUDGET_SOL` drive the
      dashboard's sizing analysis, while each strategy's own `sol_amount` drives the trades.

## ☐ 2. Close the exec-model loop — the last measurement gate

- [ ] Enable quote sampling **through Raptor** (ungated) rather than the Jupiter path
      (`JUP_QUOTE_SAMPLE_EVERY` samples Jupiter, which is the scarce budget).
- [ ] Read `impliedCoeff` from `summarizeCalibration` against those quotes, then set `SIM_IMPACT_COEFF`.
- [ ] Flip `SIM_EXECUTION_MODEL` and re-read the net with the exec model applied — `execPnlSol` is
      currently **null**: the daily view has no per-trade exec net at all.

## ☐ 3. Choose the strategy allowed to trade live

- [ ] `MCAP_LIVE_STRATEGY_ID` is hardcoded to `mcap_enter_first_seen` — the thinnest-evidenced mcap
      variant (209 positions, +0.7% median) — while `search_mcap` (medians +5.7 … +8.8%) has no live
      path at all. Widen the whitelist, or write down why the weakest is the armed one.

## ☐ 4. Stage the first real fill

- [ ] One strategy, `MAX_SOL_AT_RISK=0.1`, `MIN_SOL_BALANCE` honoured, wallet funded (~0.14 SOL today).
- [ ] Rehearse the kill switch: `MCAP_LIVE_TRADING_ENABLED=false` then recreate web — env only, no
      deploy, live path inert immediately while the paper desk keeps running.
- [ ] On-chain receipt check, and a recorded real-vs-sim delta for the first fill.

## ☐ 5. Observability before anything runs unattended

- [ ] Surface silently-stalled strategies: `social_only_fomo_gt7` last closed 09-28, `scalper` 09-24.
- [ ] Name what starves the background Jupiter lane — two slots should not produce a 29s wait. The sims
      run in-process, so they are invisible to the nginx logs.

---

## Facts to keep current

- Gate at `6a9a3a4`: tsc clean · lint 0 errors · **2041 passed | 1 skipped**.
- Paper desk, 3 days: 18,145 trades, 48.8% win, `pnlSolSized` **+5.72 SOL** with the calibrated cost
  model (`feeBps 12` / `spreadBps 0` / `priorityFeeQuote 0.00003`). That net is constant-derived, not
  per-trade calibrated — see item 2. The same desk showed a `-61.78 SOL` drag under the fabricated
  0.002 priority fee, so this figure is only as good as those constants.
- Sell latency: single token ~0.24s (trade lane); bulk estimate moved from 14.87s to **0.69s** by
  quoting the executing venue (Raptor). Prefetch TTL is 8s, so the click rebuilds by design.
