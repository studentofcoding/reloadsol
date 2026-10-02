#!/bin/bash
set -euo pipefail
# Derived from the script location so the tool is portable (and safe to commit).
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/csv"
mkdir -p "$OUT"
run_copy() {
  local file="$1"
  ssh flowey-vps 'docker exec -i reloadsol-db psql -X -q -U reloadsol -d reloadsol_db' > "$OUT/$file"
}
run_copy social_rollups.csv <<'SQL'
COPY (SELECT * FROM social_token_rollups ORDER BY token_address) TO STDOUT WITH CSV HEADER;
SQL
run_copy pattern_24h.csv <<'SQL'
COPY (
 SELECT token_address, cohort, mcap_growth_percent, first_seen_at,
        left(snapshot::text, 32000) AS snapshot,
        snapshot->'mcapTracker'->>'token_symbol' AS snapshot_token_symbol,
        snapshot->'mcapTracker'->>'first_mcap' AS snapshot_first_mcap,
        snapshot->'mcapTracker'->>'current_mcap' AS snapshot_current_mcap,
        snapshot->'mcapTracker'->>'peak_mcap' AS snapshot_peak_mcap,
        snapshot->'mcapTracker'->>'mcap_growth_percent' AS snapshot_mcap_growth_percent,
        snapshot->'mcapTracker'->>'peak_growth_percent' AS snapshot_peak_growth_percent,
        snapshot->'mcapTracker'->>'top_holders_pct' AS snapshot_top_holders_pct,
        snapshot->'mcapTracker'->>'organic_score' AS snapshot_organic_score,
        snapshot->'mcapTracker'->>'volume_5m' AS snapshot_volume_5m,
        snapshot->'mcapTracker'->>'label' AS snapshot_label,
        snapshot->'mcapTracker'->>'first_seen_at' AS snapshot_mcap_first_seen,
        snapshot->'mcapTracker'->>'peak_seen_at' AS snapshot_peak_seen_at,
        snapshot->'mcapTracker'->>'stop_reason' AS snapshot_stop_reason,
        updated_at, chain
 FROM mcap_social_pattern_24h ORDER BY mcap_growth_percent DESC NULLS LAST, token_address
) TO STDOUT WITH CSV HEADER;
SQL
run_copy pattern_winners.csv <<'SQL'
COPY (
 SELECT token_address, cohort, mcap_growth_percent, first_seen_at,
        left(snapshot::text, 32000) AS snapshot,
        snapshot->'mcapTracker'->>'token_symbol' AS snapshot_token_symbol,
        snapshot->'mcapTracker'->>'first_mcap' AS snapshot_first_mcap,
        snapshot->'mcapTracker'->>'current_mcap' AS snapshot_current_mcap,
        snapshot->'mcapTracker'->>'peak_mcap' AS snapshot_peak_mcap,
        snapshot->'mcapTracker'->>'mcap_growth_percent' AS snapshot_mcap_growth_percent,
        snapshot->'mcapTracker'->>'peak_growth_percent' AS snapshot_peak_growth_percent,
        snapshot->'mcapTracker'->>'top_holders_pct' AS snapshot_top_holders_pct,
        snapshot->'mcapTracker'->>'organic_score' AS snapshot_organic_score,
        snapshot->'mcapTracker'->>'volume_5m' AS snapshot_volume_5m,
        snapshot->'mcapTracker'->>'label' AS snapshot_label,
        snapshot->'mcapTracker'->>'first_seen_at' AS snapshot_mcap_first_seen,
        snapshot->'mcapTracker'->>'peak_seen_at' AS snapshot_peak_seen_at,
        snapshot->'mcapTracker'->>'stop_reason' AS snapshot_stop_reason,
        updated_at, chain
 FROM mcap_social_pattern_24h WHERE cohort='winner' ORDER BY mcap_growth_percent DESC NULLS LAST, token_address
) TO STDOUT WITH CSV HEADER;
SQL
run_copy pattern_losers.csv <<'SQL'
COPY (
 SELECT token_address, cohort, mcap_growth_percent, first_seen_at,
        left(snapshot::text, 32000) AS snapshot,
        snapshot->'mcapTracker'->>'token_symbol' AS snapshot_token_symbol,
        snapshot->'mcapTracker'->>'first_mcap' AS snapshot_first_mcap,
        snapshot->'mcapTracker'->>'current_mcap' AS snapshot_current_mcap,
        snapshot->'mcapTracker'->>'peak_mcap' AS snapshot_peak_mcap,
        snapshot->'mcapTracker'->>'mcap_growth_percent' AS snapshot_mcap_growth_percent,
        snapshot->'mcapTracker'->>'peak_growth_percent' AS snapshot_peak_growth_percent,
        snapshot->'mcapTracker'->>'top_holders_pct' AS snapshot_top_holders_pct,
        snapshot->'mcapTracker'->>'organic_score' AS snapshot_organic_score,
        snapshot->'mcapTracker'->>'volume_5m' AS snapshot_volume_5m,
        snapshot->'mcapTracker'->>'label' AS snapshot_label,
        snapshot->'mcapTracker'->>'first_seen_at' AS snapshot_mcap_first_seen,
        snapshot->'mcapTracker'->>'peak_seen_at' AS snapshot_peak_seen_at,
        snapshot->'mcapTracker'->>'stop_reason' AS snapshot_stop_reason,
        updated_at, chain
 FROM mcap_social_pattern_24h WHERE cohort='loser' ORDER BY mcap_growth_percent DESC NULLS LAST, token_address
) TO STDOUT WITH CSV HEADER;
SQL
run_copy source_mix.csv <<'SQL'
COPY (
 SELECT 'rollup_first_source' AS category, first_source AS key, count(*)::bigint AS count
 FROM social_token_rollups GROUP BY first_source
 UNION ALL
 SELECT 'event_7d_type' AS category, event_type AS key, count(*)::bigint AS count
 FROM social_token_events WHERE occurred_at >= now() - interval '7 days' GROUP BY event_type
 UNION ALL
 SELECT 'event_7d_source' AS category, source AS key, count(*)::bigint AS count
 FROM social_token_events WHERE occurred_at >= now() - interval '7 days' GROUP BY source
 ORDER BY category, count DESC, key
) TO STDOUT WITH CSV HEADER;
SQL
run_copy social_enriched.csv <<'SQL'
COPY (
 WITH rug AS (
   SELECT token_address,
          true AS is_rugged,
          string_agg(DISTINCT source, ', ' ORDER BY source) AS rug_sources,
          bool_or(source='concentration') AS concentration_banned,
          min(added_at) FILTER (WHERE source='concentration') AS concentration_added_at
   FROM token_rug_list GROUP BY token_address
 ), detect AS (
   SELECT DISTINCT ON (token_address)
          token_address, detected_at,
          features->>'dumpPct' AS detect_dumpPct,
          features->>'avgUpperWick' AS detect_avgUpperWick,
          features->>'volDeathRatio' AS detect_volDeathRatio,
          features->>'upOnlyCount' AS detect_upOnlyCount,
          features->>'n' AS detect_n,
          features->>'wickTripBars' AS detect_wickTripBars
   FROM token_detect_snapshots
   WHERE source='concentration'
   ORDER BY token_address, detected_at ASC
 )
 SELECT s.*,
        p.cohort AS pattern_cohort,
        p.mcap_growth_percent AS pattern_mcap_growth_percent,
        p.first_seen_at AS pattern_first_seen_at,
        m.token_symbol AS mcap_token_symbol,
        m.first_mcap AS mcap_first_mcap,
        m.current_mcap AS mcap_current_mcap,
        m.peak_mcap AS mcap_peak_mcap,
        m.mcap_growth_percent AS mcap_growth_percent,
        m.peak_growth_percent AS mcap_peak_growth_percent,
        m.top_holders_pct AS mcap_top_holders_pct,
        m.organic_score AS mcap_organic_score,
        m.volume_5m AS mcap_volume_5m,
        m.label AS mcap_label,
        m.first_seen_at AS mcap_first_seen,
        m.peak_seen_at AS mcap_peak_seen_at,
        m.stop_reason AS mcap_stop_reason,
        r.is_rugged, r.rug_sources, r.concentration_banned, r.concentration_added_at,
        d.detected_at AS concentration_detect_at,
        d.detect_dumpPct AS "detect_dumpPct",
        d.detect_avgUpperWick AS "detect_avgUpperWick",
        d.detect_volDeathRatio AS "detect_volDeathRatio",
        d.detect_upOnlyCount AS "detect_upOnlyCount",
        d.detect_n AS "detect_n",
        d.detect_wickTripBars AS "detect_wickTripBars",
        t.detected_at AS ledger_detected_at,
         t.detecting_strategy AS ledger_strategy,
         t.source AS ledger_source,
         t.top10_hold_pct AS ledger_top10_hold_pct,
         t.dev_hold_pct AS ledger_dev_hold_pct,
         t.bundlers_hold_pct AS ledger_bundlers_hold_pct,
         t.insiders_hold_pct AS ledger_insiders_hold_pct,
         t.snipers_hold_pct AS ledger_snipers_hold_pct,
         t.sniper_wallet_count AS ledger_sniper_wallet_count,
         t.pro_traders_pct AS ledger_pro_traders_pct,
         t.freeze_auth_active AS ledger_freeze_auth,
         t.mint_auth_active AS ledger_mint_auth,
         t.dex_boost_label AS ledger_dex_boost
 FROM social_token_rollups s
 LEFT JOIN mcap_social_pattern_24h p ON p.token_address=s.token_address
 LEFT JOIN token_mcap_tracking m ON m.token_address=s.token_address AND m.chain=s.chain
 LEFT JOIN rug r ON r.token_address=s.token_address
 LEFT JOIN detect d ON d.token_address=s.token_address
 LEFT JOIN token_info_detect t ON t.token_address=s.token_address AND t.chain=s.chain
 ORDER BY s.token_address
) TO STDOUT WITH CSV HEADER;
SQL
run_copy rugs_concentration.csv <<'SQL'
COPY (SELECT * FROM token_rug_list WHERE source='concentration' ORDER BY added_at, token_address) TO STDOUT WITH CSV HEADER;
SQL
run_copy rugs_all.csv <<'SQL'
COPY (SELECT * FROM token_rug_list ORDER BY added_at, token_address) TO STDOUT WITH CSV HEADER;
SQL
run_copy detect_concentration.csv <<'SQL'
COPY (
 SELECT token_address, detected_at, rug_label,
        features->>'dumpPct' AS "dumpPct",
        features->>'avgUpperWick' AS "avgUpperWick",
        features->>'volDeathRatio' AS "volDeathRatio",
        features->>'upOnlyCount' AS "upOnlyCount",
        features->>'n' AS "n",
        features->>'wickTripBars' AS "wickTripBars",
        source, ohlc_interval, id, updated_at
 FROM token_detect_snapshots WHERE source='concentration'
 ORDER BY detected_at, token_address
) TO STDOUT WITH CSV HEADER;
SQL
run_copy mention_top.csv <<'SQL'
COPY (
 WITH rug AS (
   SELECT token_address, true AS is_rugged,
          string_agg(DISTINCT source, ', ' ORDER BY source) AS rug_sources,
          bool_or(source='concentration') AS concentration_banned,
          min(added_at) FILTER (WHERE source='concentration') AS concentration_added_at
   FROM token_rug_list GROUP BY token_address
 ), detect AS (
   SELECT DISTINCT ON (token_address) token_address, detected_at,
          features->>'dumpPct' AS detect_dumpPct,
          features->>'avgUpperWick' AS detect_avgUpperWick,
          features->>'volDeathRatio' AS detect_volDeathRatio,
          features->>'upOnlyCount' AS detect_upOnlyCount,
          features->>'n' AS detect_n,
          features->>'wickTripBars' AS detect_wickTripBars
   FROM token_detect_snapshots WHERE source='concentration'
   ORDER BY token_address, detected_at ASC
 )
 SELECT s.token_address, s.mention_count_24h, s.first_seen_at, s.first_source,
        s.first_channel, s.top_source, s.chain,
        p.cohort AS pattern_cohort, p.mcap_growth_percent AS pattern_mcap_growth_percent,
        p.first_seen_at AS pattern_first_seen_at,
        m.token_symbol AS mcap_token_symbol, m.first_mcap AS mcap_first_mcap,
        m.current_mcap AS mcap_current_mcap, m.peak_mcap AS mcap_peak_mcap,
        m.mcap_growth_percent AS mcap_growth_percent,
        m.top_holders_pct AS mcap_top_holders_pct,
        m.organic_score AS mcap_organic_score, m.volume_5m AS mcap_volume_5m,
        m.label AS mcap_label, m.first_seen_at AS mcap_first_seen,
        m.peak_seen_at AS mcap_peak_seen_at, m.stop_reason AS mcap_stop_reason,
        r.is_rugged, r.rug_sources, r.concentration_banned, r.concentration_added_at,
         d.detected_at AS concentration_detect_at,
         d.detect_dumpPct AS "detect_dumpPct",
         d.detect_avgUpperWick AS "detect_avgUpperWick",
         d.detect_volDeathRatio AS "detect_volDeathRatio",
         d.detect_upOnlyCount AS "detect_upOnlyCount",
         d.detect_n AS "detect_n",
         d.detect_wickTripBars AS "detect_wickTripBars",
         t.detected_at AS ledger_detected_at,
         t.detecting_strategy AS ledger_strategy,
         t.source AS ledger_source,
         t.top10_hold_pct AS ledger_top10_hold_pct,
         t.dev_hold_pct AS ledger_dev_hold_pct,
         t.bundlers_hold_pct AS ledger_bundlers_hold_pct,
         t.insiders_hold_pct AS ledger_insiders_hold_pct,
         t.snipers_hold_pct AS ledger_snipers_hold_pct,
         t.sniper_wallet_count AS ledger_sniper_wallet_count,
         t.pro_traders_pct AS ledger_pro_traders_pct,
         t.freeze_auth_active AS ledger_freeze_auth,
         t.mint_auth_active AS ledger_mint_auth,
         t.dex_boost_label AS ledger_dex_boost
 FROM social_token_rollups s
 LEFT JOIN mcap_social_pattern_24h p ON p.token_address=s.token_address
 LEFT JOIN token_mcap_tracking m ON m.token_address=s.token_address AND m.chain=s.chain
 LEFT JOIN rug r ON r.token_address=s.token_address
 LEFT JOIN detect d ON d.token_address=s.token_address
 LEFT JOIN token_info_detect t ON t.token_address=s.token_address AND t.chain=s.chain
 ORDER BY s.mention_count_24h DESC NULLS LAST, s.token_address
 LIMIT 100
) TO STDOUT WITH CSV HEADER;
SQL
printf 'CSV export complete in %s\n' "$OUT"
wc -l "$OUT"/*.csv
