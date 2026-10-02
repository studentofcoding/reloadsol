-- Cross-strategy token overlap: which tokens more than one strategy entered.
--
-- Same token under one strategy is a defect (enforced by
-- 45-strategy-outcomes-identity.sql). The same token under DIFFERENT strategies is
-- signal — strategy agreement — and nothing in the codebase surfaced it: the
-- closest existing primitive, meanPairwiseOverlapCorr in
-- token-map-strategy-chart-paint.ts, is DOMAIN-level (strategy family) and
-- single-token, and utils/algo/correlation-analysis.ts is token-returns-vs-SOL.
--
-- Read via src/strategies/db.ts (aggregateStrategyReports) for the Reports
-- "Overlap" table. Measured cost of the equivalent grouping on prod: ~5 ms for a
-- one-day window, so a plain view is enough; promote to a matview refreshed by the
-- sim cron only if a full-table scan starts showing in pg_stat_statements.
--
-- Consumers must NOT sum pnl_pct across a token's strategies (that double-counts
-- one token's move and is not a portfolio return) and must prefer median_pnl_pct
-- over a mean, which is dominated by the right tail (2026-09-29: mean +119.7% vs
-- median +2.2%, with the top 10 trades = 57% of the day's total).
--
-- NOTE: strategy_count here is RAW count(DISTINCT strategy_id), and it overstates
-- agreement: the search spawner fills its slots with grid neighbours that differ only
-- in take profit (measured Jaccard 0.37-0.66 between them). This view cannot resolve
-- families (a view cannot call the TS rule), so the family-counted breadth, the
-- pairwise Jaccard and the consensus test live in src/strategies/db.ts
-- (loadTokenStrategyOverlap / loadStrategyPairOverlap / loadConsensusTest) on top of
-- src/strategies/strategy-family.ts. Use this view for raw ad-hoc reads only.

CREATE OR REPLACE VIEW token_strategy_overlap AS
SELECT chain,
       token_address,
       count(DISTINCT strategy_id)                          AS strategy_count,
       array_agg(DISTINCT strategy_id ORDER BY strategy_id) AS strategies,
       count(*)                                             AS trades,
       count(*) FILTER (WHERE pnl_pct > 1e-6)               AS wins,
       count(*) FILTER (WHERE pnl_pct < -1e-6)              AS losses,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct))::numeric AS median_pnl_pct,
       min(entry_at) AS first_entry,
       max(exit_at)  AS last_exit
  FROM strategy_outcomes
 WHERE token_address IS NOT NULL
 GROUP BY chain, token_address;
