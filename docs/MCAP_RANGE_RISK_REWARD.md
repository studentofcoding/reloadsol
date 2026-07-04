# MCap Range Risk & Reward Metrics

This document defines the Risk and Reward metrics implemented for MCap Range Analysis.

## Goals

- Provide clear, robust “Risk” and “Reward” metrics for each market-cap range bucket.
- Make metrics useful across both new and old tokens (even with limited history).
- Keep computation simple and performant.

## Current Status

- **Backend (API):** Fully implemented in `src/app/api/mcap-tracking/route.ts`. The API returns comprehensive statistics including quantiles, volatility, and time-based metrics.
- **Frontend (UI):** Partially integrated. The data is available in the API response, and visualizations like `PnlDistributionChart` use parts of this data.

## Implemented Metrics

The API (`calculateRangeStats`) computes the following metrics for each MCap bucket:

### Reward (Cross-sectional)

- **MedianMultiplier:** The median return multiple (current/first). Robust to outliers.
- **P75Multiplier:** The 75th percentile multiplier (upper quartile).
- **MedianGrowth:** Median growth percentage.
- **P75Growth, P90Growth:** 75th and 90th percentile growth percentages.
- **HitRate120:** Percentage of tokens that have reached +120% growth.
- **AvgMultiplier:** Average return multiple (can be skewed by outliers).

### Risk

- **WorstGrowth:** The minimum growth percentage in the bucket (Maximum Drawdown).
- **P25Growth:** The 25th percentile growth (typical loser performance).
- **StopLossRate:** Percentage of tokens with growth ≤ -50%.
- **StuckRate:** Percentage of tokens marked as `is_tracking_stuck` (near-zero growth for extended period).
- **BucketVolatility:** Standard deviation of growth percentages.

### General

- **Count:** Number of tokens in the bucket.
- **GrowthHistogram:** Distribution of growth percentages across defined bins.

## Bucket Definitions

Buckets are based on `first_mcap` (entry conditions):

- **under50k:** `first_mcap < 50,000`
- **from51to100k:** `50,001 <= first_mcap <= 100,000`
- **from101to200k:** `100,001 <= first_mcap <= 200,000`
- **from201to500k:** `200,001 <= first_mcap <= 500,000`
- **from501kto1M:** `500,001 <= first_mcap <= 1,000,000`
- **over1M:** `first_mcap > 1,000,000`

> **Note:** A small boundary gap exists at exactly 50,000 (excluded from both `under50k` and `from51to100k`).

## Data Requirements

The metrics rely on the following fields from `token_mcap_tracking`:

- `first_mcap`, `current_mcap`, `mcap_growth_percent`
- `is_tracking_stuck`

## Implementation Details

### Computation Formulas

- **Multiplier:** `current_mcap / first_mcap`
- **Growth%:** `mcap_growth_percent` (tracked field)
- **Quantiles (P25, P50, P75, P90):** Calculated using linear interpolation on sorted data.
- **Volatility:** `sqrt(variance)` of growth percentages.
- **StopLossRate:** `count(growth <= -50) / count(valid_records) * 100`
- **StuckRate:** `count(is_tracking_stuck == true) / count(valid_records) * 100`

### Performance

- Statistics are computed in-memory on the serverless function.
- The query limit is set to **100,000** records to ensure the sample size represents the full dataset.

## Future Improvements

- **Composite Scores:** Calculate normalized `RewardScore` and `RiskScore` (0-100) based on the raw metrics.
- **Bucket Boundary Fix:** Close the gap at `first_mcap = 50,000`.
- **Time-Based Metrics:** Fully integrate `avgTimeTo80`, `avgTimeTo120` using `when_reach_XXpct` timestamps (currently partially implemented in PnL windows).
