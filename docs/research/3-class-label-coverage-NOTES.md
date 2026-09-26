# Research: 3-class label coverage (Sol) — #80

**Queried:** 2026-09-27 ~03:00 WIB via `docker exec reloadsol-db psql -U reloadsol -d reloadsol_db` on flowey-vps.  
**Scope:** `token_mcap_tracking` where `chain = 'sol'`. Facts only; no train.

## Locked growth labels

| Class | Rule |
|-------|------|
| loser | `mcap_growth_percent < 0` |
| winner | `> 20` AND `< 120` |
| moonbag | `≥ 120` |
| unlabeled / neutral gap | `0 ≤ x ≤ 20` (reported, not a train class) |

## `token_mcap_tracking` (Sol)

| Metric | N |
|--------|--:|
| Sol rows | 21,904 |
| `mcap_growth_percent` NOT NULL | 21,904 |
| growth NULL | 0 |
| `first_seen_at` NULL | 0 (`NOT NULL DEFAULT now()`) |
| loser `<0` | 6,961 (31.78%) |
| winner `>20 & <120` | 4,089 (18.67%) |
| moonbag `≥120` | 1,654 (7.55%) |
| neutral gap `0–20` | 9,200 (42.00%) — of which **5,823** are exactly `0` |
| **Labeled 3-class total** | **12,704** |

Other chains on same table: robinhood 7,642 (excluded).

Operational `label` column (unrelated to growth classes): potential 11,675; null 5,565; rugged 4,664.

## Pattern table note (`mcap_social_pattern_24h`, Sol)

- 387 Sol rows; **100% overlap** with `token_mcap_tracking` (0 pattern-only).
- Stored cohorts use **different** thresholds today: winner ≥120%, loser &lt;80% (neutrals not stored as a cohort). Counts: loser 330, winner 57.
- Re-bucketing pattern growth with locked 3-class: loser 143 / winner 46 / moonbag 57 / neutral gap 141 — so pattern "loser" mixes locked loser + gap + some locked-winner band.

## Feasibility (retrain export, no new APIs)

**Yes.** All Sol labeled rows are already in Postgres with non-null `mcap_growth_percent`. Export via SQL/`COPY` (or existing app DB access) is enough for **labels**; no new external APIs required.

```sql
-- labeled 3-class Sol export skeleton
SELECT token_address, token_symbol, first_mcap, current_mcap, mcap_growth_percent,
       peak_mcap, peak_growth_percent, first_seen_at, last_updated_at, chain,
       CASE
         WHEN mcap_growth_percent < 0 THEN 'loser'
         WHEN mcap_growth_percent > 20 AND mcap_growth_percent < 120 THEN 'winner'
         WHEN mcap_growth_percent >= 120 THEN 'moonbag'
       END AS growth_class_3
FROM token_mcap_tracking
WHERE chain = 'sol'
  AND mcap_growth_percent IS NOT NULL
  AND (mcap_growth_percent < 0
       OR (mcap_growth_percent > 20 AND mcap_growth_percent < 120)
       OR mcap_growth_percent >= 120);
```

Caveats (not blockers for labeling):

- Existing `GET /api/mcap-patterns/training-export` / `ml:export-patterns` still use **pattern cohort** rules (winner≥120 / loser&lt;80), not this 3-class map — do not reuse that export as-is for 3-class retrain.
- Neutral gap (9,200 / 42%) is large; exclude from 3-class train set unless product decides otherwise.
- Feature vectors (social snapshot, etc.) are separate from label availability; this research confirms **label coverage only**.

## Parent

https://github.com/studentofcoding/reloadsol/issues/80 (parent map #79)
