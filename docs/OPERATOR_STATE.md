# Operator state (feedback loop)

Living notes for regime awareness and rule changes. The LLM gate (Layer 3) should read **regime tags + recent outcomes + this file**, not strategy scoring weights.

Update after significant sim batches or when disabling a strategy.

## North star

**Strict checker over brilliant maker.** Primary thesis: `mcap_enter_at_80` sim (milestone entry). Everything else compounds that safely.

## Current focus

| Strategy | Status | Notes |
|----------|--------|-------|
| `mcap_enter_at_80` | **Primary — FROZEN** | Rules locked for data collection; target **200+ sim closes** before ML enforce or live |
| `att` | Active | Registry floor **200k mcap** — sub-50k entries should not assign here; bad under50k WR is usually `lowcap_moonbag` or legacy rows |
| `lowcap_moonbag` | Active | 35k–90k band; deactivate if WR stays &lt;10% over 30+ trades |
| `signals_sell_over_100` | Sim only | Exits on mcap ≥100%; sim PnL now uses mcap basis (fixed price/rug mismatch) |

## Constraints (learned)

- Do not gate live trades on ML until `model.meta.json` → `metrics.gate_ready === true` (macro-F1 ≥ 0.65 on holdout).
- ML checker (Layer 2) must see **entry features only** — never strategy weights or scores (`docs/ML_GATE_PLAN.md`).
- Target checker rejection **40–60%** of candidates in shadow mode; &gt;90% approval means gates are too loose.
- LLM gate (Layer 3): ambiguous cases only; economics favor ONNX-only below ~$100k–250k deployed.

## Regime

Daily tags: Strategy Admin → Reports → **Market regime** (`market_regime_tags` table).

## Data hygiene

- Run `npm run ml:backfill-labels` after tier label changes.
- Export versioned data: `npm run ml:export` → `ml/data/v2/training.parquet` + `dataset_manifest.json`.
- Train gate: `npm run ml:train-gate` → `ml/artifacts/v2-gate/`
- Train potential (advisory): `npm run ml:train-potential` → `ml/artifacts/v2-potential/`
- Check: `npm run ml:check-dataset` / `npm run ml:check-potential`
- Shadow scoring runs on mcap sim opens (`entry_features.ml_gate_*`); **enforce wired but default `ML_GATE_MODE=shadow`**
- Social TTL cleanup every 30m (Go cron → `/api/social/cleanup`); `/dev/social` is manual refresh only
- **Supabase egress (Free plan 5 GB/mo):** social rollup every 5m (was 2m); rollup query omits `raw_metadata`. If Dashboard shows egress overage → Cloudflare **522** on API calls until quota resets or plan upgrades. Check **Settings → Usage → Egress** in Supabase.
- Weekly loop: `npm run ml:export` → `ml:train-gate` → `ml:check-dataset`; review shadow `ml_gate_p_bad` histogram before setting `ML_GATE_MODE=enforce`
- Do not gate live on v1 multiclass (overfit); use v2-gate `gate_ready` only

## Risk / kill switch

- Real trending bot: global circuit breaker in `bot_trading_state` (auto halt on failures).
- DLMM pause is separate (Telegram `/pause`) — not unified yet.
- Sim workers are **not** halted by real-trading circuit breaker.

## Changelog

| Date | Change |
|------|--------|
| 2026-06-28 | Social TTL cleanup + manual `/dev/social` refresh; `social_overlap` on entry features; L2 enforce wired (default shadow) |
| 2026-06-28 | Two-stage ML: v2-gate binary + v2-potential tiers; shadow ONNX on mcap sim-track |
| 2026-06-28 | Fixed signals sim PnL (mcap vs price); symbol backfill from `token_mcap_tracking`; versioned ML export + gate_ready in train meta |
