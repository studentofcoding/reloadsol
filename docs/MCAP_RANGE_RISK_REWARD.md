# MCap Range Risk & Reward Metrics

This document defines Risk and Reward metrics for MCap Range Analysis, highlights current limitations, and lays out a step-by-step plan to implement them in the API and UI.

## Goals

- Provide clear, robust “Risk” and “Reward” metrics for each market-cap range bucket.
- Make metrics useful across both new and old tokens (even with limited history).
- Keep computation simple and performant, with a path to scale later.

## Current State (Summary)

- Buckets are based on `first_mcap` (entry conditions), and the API returns per-bucket:
  - Count
  - Avg Multiplier
  - “Max Drawdown” (currently the minimum growth across tokens)
  - Avg Growth
- Limitations:
  - “Max Drawdown” is a misnomer: it’s not a time-series drawdown; it’s the worst cross-sectional return in the bucket.
  - Averages get skewed by outliers (e.g., 20–50x winners).
  - No quantiles/percentiles to understand distribution shape.
  - A small boundary gap exists at exactly 50,000 (under50k is `< 50,000`, next bucket starts at `50,001`).
  - Time-to-thresholds (when_reach_80mc, 120mc, 200mc) aren’t included in the overall stats query, so we can’t compute speed-based reward per bucket.
  - `is_tracking_stuck` (intended to be 6-hour zero-growth) should be used to compute a “stuck rate” per bucket once the 6-hour threshold is applied.

## Proposed Metrics

We split metrics into Reward and Risk to better communicate each bucket’s profile.

### Reward (Cross-sectional across tokens in a bucket)

- MedianMultiplier — typical multiplier, robust to outliers.
- P75Multiplier — upper-quartile multiplier (what solid winners look like).
- MedianGrowth — median growth %.
- P75Growth, P90Growth — upside distribution markers.
- HitRate_120 — share of tokens that reached +120% growth at any time.
- AvgTimeTo80 / AvgTimeTo120 — average time (hours) for tokens that hit +80%/+120% from `first_seen_at` to `when_reach_XXmc`.

### Risk

- WorstGrowth — minimum growth in the bucket. (Rename the existing “Max Drawdown” to “Worst Growth” for accuracy).
- P25Growth — downside quartile (how bad is a typical loser).
- StopLossRate — share of tokens with growth ≤ -50% (aligned with stop-loss policy).
- StuckRate — share of tokens marked `is_tracking_stuck = true` (6-hour near-zero growth), or fallback to abs(growth) ≤ epsilon if needed.
- VolatilityGrowth — standard deviation of growth percentages (dispersion proxy).
- P5Growth — severe downside tail (optional if sample size is large enough).

### Optional Composite Scores (Phase 2)

- RewardScore [0–100]: normalized mix of P75Growth, HitRate_120, and inverse AvgTimeTo120.
- RiskScore [0–100]: normalized mix of negative P25Growth, StopLossRate, StuckRate, and VolatilityGrowth.
- Reward/Risk Ratio to compare buckets quickly. Apply caps/clamps for stability.

## Bucket Definitions

Continue using `first_mcap` (entry conditions) to define buckets:

- under50k: `first_mcap <= 50,000` (fix boundary to close the gap)
- from51to100k: `50,001–100,000`
- from101to200k: `100,001–200,000`
- from201to500k: `200,001–500,000`
- from501kto1M: `500,001–1,000,000`
- over1M: `> 1,000,000`

If desired, we can add a toggle later to analyze by `current_mcap` instead.

## Data Requirements

- From `token_mcap_tracking`:
  - `first_mcap`, `current_mcap`, `mcap_growth_percent`
  - `first_seen_at`, `last_updated_at`
  - `when_reach_80mc`, `when_reach_120mc`, `when_reach_200mc` (for time-to-threshold metrics)
  - `is_tracking_stuck` (after applying 6-hour zero-growth logic)

## Formulas and Computation Details

- Multiplier: `current_mcap / first_mcap`
- Growth%: `((current_mcap - first_mcap) / first_mcap) * 100`
- Quantiles:
  - Sort ascending; P25/P50/P75/P90 via nearest-rank or linear interpolation (choose nearest-rank for simplicity).
- Volatility (StdDev of Growth%):
  - `sqrt(variance)`, variance computed over `%` growth.
- StopLossRate:
  - `count(growth <= -50) / count(all)`
- StuckRate:
  - `count(is_tracking_stuck = true) / count(all)`
  - Fallback if not available: `count(abs(growth) <= epsilon) / count(all)`
- Time to threshold (hours):
  - `diffHours = (when_reach_X - first_seen_at) / (1000*60*60)`
  - Average across tokens where `when_reach_X` is non-null.

## API Changes (Backend)

In `src/app/api/mcap-tracking/route.ts`:

1) Extend the `allDataQuery.select` to include:
   - `when_reach_80mc`, `when_reach_120mc`, `when_reach_200mc`
   - `is_tracking_stuck`

2) Fix bucket boundary for `under50k` vs `from51to100k`.

3) Update `calculateRangeStats(data, rangeName)` to compute and return:
   - Existing: `count`, `avgMultiplier`, `avgGrowth`
   - New Reward:
     - `medianMultiplier`, `p75Multiplier`
     - `medianGrowth`, `p75Growth`, `p90Growth`
     - `hitRate120`, `avgTimeTo80`, `avgTimeTo120`
   - New Risk:
     - `worstGrowth` (rename previous “maxDrawdown” meaning)
     - `p25Growth`, `stopLossRate`, `stuckRate`, `volatilityGrowth`
   - Keep a `maxDrawdown` field for backward-compatibility in the response (alias of `worstGrowth`) to avoid breaking the UI immediately.

4) Add bucket-level debug logs:
   - Sizes, quantiles, stddev
   - Counts for stuck, ≤ -50%, threshold hits
   - Count of `first_mcap == 50,000` (before/after fix)

## UI Changes (Dev Page)

In `src/app/dev/mcap-tracker/page.tsx`:

- Under each range card, add a compact “Risk/Reward” sub-grid:
  - Reward: Median/P75 multiplier, P90 growth, HitRate_120, AvgTimeTo80/120
  - Risk: WorstGrowth (rename label from “Max Drawdown”), P25Growth, StopLossRate, StuckRate, VolatilityGrowth
- Keep the original (Count, Avg Multiplier, Avg Growth) until we fully migrate.

## Implementation Steps

1) Bucket Boundary Fix
   - Update `under50k` to include `first_mcap <= 50,000`; start next bucket at `50,001`.
   - Log how many records are exactly `50,000` for validation.

2) Extend Stats Query
   - Include `when_reach_80mc`, `when_reach_120mc`, `when_reach_200mc`, `is_tracking_stuck` in the `allDataQuery.select`.

3) Enhance `calculateRangeStats`
   - Implement quantile and stddev helpers.
   - Compute Reward/Risk metrics listed above.
   - Keep `maxDrawdown` as alias to `worstGrowth` for compatibility.

4) Update Response Types and UI
   - Extend typing on the client.
   - Render the new Risk/Reward sub-sections on each card.

5) Logging & Validation
   - Console logs per bucket for all new metrics.
   - Verify bucket counts, especially boundary at 50k.

6) Optional Composite Scores (Phase 2)
   - Add normalized `RewardScore` and `RiskScore` and a ratio.

## Testing

- Call `GET /api/mcap-tracking` without filters to get the full population.
- Check logs for:
  - Each bucket’s counts, quantiles, stddev, stuck/stop-loss rates, and hit rates.
- In the Dev UI:
  - Ensure new fields appear under each bucket.
  - Sanity check: under50k should have more dispersion and higher hit-rate variance compared to over1M.

## Performance Considerations

- Current approach computes stats in memory over all records fetched.
- If the table grows large, we can:
  - Add date windows (e.g., last 30/60/90 days).
  - Move aggregates to SQL with `percentile_cont`/`approx_percentile` where supported.
  - Cache results and refresh periodically.

## Operational & Monitoring

- Add structured logs around bucket stats generation to quickly detect regressions.
- Consider a `/api/mcap-tracking?action=health` view summarizing stuck rates and stop-loss rates overall.

## Open Choices (Please Confirm)

- Bucket basis: Keep using `first_mcap` (entry conditions)? Or switch to `current_mcap`?
- Thresholds in Reward: Use 80% and 120% (already tracked). Should we also include 200% now, or later?
- Zero-PnL handling: Show metrics “including zero” and “excluding zero”, or stick to a single variant?
- Composite Scores: Include RewardScore/RiskScore now, or add after we validate the raw metrics?