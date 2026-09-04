# ReloadSOL — Diagrams

Six self-contained HTML architecture diagrams (inline SVG, Flowey brand palette —
warm paper / deep emerald / lime). Open each in a browser; they render standalone and
are screen-reader friendly (`role="img"` + prefixed `<title>`/`<desc>`).

| # | Diagram | Type | Opens |
|---|---------|------|-------|
| 01 | Trading surfaces → execution → records | Architecture | [01-trading-surfaces.html](./diagrams/01-trading-surfaces.html) |
| 02 | Trade confirmation lifecycle | Sequence | [02-confirmation-lifecycle.html](./diagrams/02-confirmation-lifecycle.html) |
| 03 | System architecture on one VPS | Architecture | [03-system-architecture.html](./diagrams/03-system-architecture.html) |
| 04 | Strategy engine spine | Data flow | [04-strategy-engine.html](./diagrams/04-strategy-engine.html) |
| 05 | ML pipeline | Process | [05-ml-pipeline.html](./diagrams/05-ml-pipeline.html) |
| 06 | Web deploy runbook | Flow | [06-deploy-and-ops.html](./diagrams/06-deploy-and-ops.html) |

## What each diagram shows

**01 — Trading surfaces → execution → records.** The four trading surfaces (bulk
buy/sell, swap, chart-buy modal, PnL/history) route to per-network executors — Solana
via Raptor/Jupiter, Robinhood-bound via GMGN server-sign, Robinhood-parent via Kyber +
Rabby (executor → EIP-5792 → sequential) — and every settled leg writes a
`trading_records` row that fans out over SSE to the history UI. Links:
[01-product-and-trading.md](./01-product-and-trading.md).

**02 — Trade confirmation lifecycle.** A swap is recorded `pending` at submit, the
executor waits for the real on-chain receipt, and only then is the record promoted —
`reverted/rejected` → `failed`, `receipt success` → `confirmed` — and pushed to the
history feed over SSE. This is the receipt-gating fix that kept reverted transactions
from being reported as confirmed.

**03 — System architecture on one VPS.** The Docker Compose stack: nginx edge →
`reloadsol-web` (Next.js API + UI, ONNX shadow scorers), `reloadsol-cron` (Go scheduler
hitting the web API), `social-ingest` (Telethon) → Postgres 16 via PgBouncer + Redis
(cache/locks/SSE).

**04 — Strategy engine spine.** `strategy_definitions` (registry + DB overrides,
`is_active`) → Go cron `trigger/*` → workers (screen/manage) → sim/live positions in
`trading_records` and closed results in `strategy_outcomes` → alerts (Telegram/Discord)
and ML shadow scoring (feedback loop).

**05 — ML pipeline.** Labeled outcomes → export (`export_*.py` → parquet) → train
(3-way split, threshold tuned on valid) → evaluate (PR-AUC + readiness bars) → ship
(`lgb+onnx+meta`) → web runtime shadow scores on sim-track opens, which re-label
outcomes over time.

**06 — Web deploy runbook.** `git pull` → host `next build`
(`SKIP_BUILD_CHECKS=true`) → verify standalone + ONNX libs → build web image → recreate
web (`--no-deps`, cron stays up) → health check; failure rolls back to the previous web
image; success warms the cache.
