# SPEC — Open-attempt record, failed-open policy and Telegram opens reporter v1

**Status:** implemented. Recording and reporting default **on**; the retry policy defaults **off** (`OPEN_RETRY_POLICY=1`).  
**Date:** 2026-10-04  
**Wayfinder:** [map #140](https://github.com/studentofcoding/reloadsol/issues/140) (paper-trading evidence architecture).

## Goal

Answer "how many paper opens succeed, fail, or are held back — and why?" from durable data, tell the operator
hourly and daily in the existing Telegram alert chat, and make a failing open behave the way the user decided:
**retry twice; if the price moved more than 5 % (either direction) since the last failed try, fail loudly and skip.**

## 1. The record — `position_open_attempts` (`db/init/65-position-open-attempts.sql`)

One row per attempt: `strategy_id` (spine worker id when the strategy id is not in scope), `token_address`, `outcome`
(`success` | `failed` | `skipped`), `stage`, `reason`, `attempt_no`, `is_final`, `price_usd`, `prev_price_usd`,
`price_move_pct`, `detail`.

Written best-effort (never delays or fails an open) from two places:

| Writer | Rows |
|---|---|
| `appendSpineDecision` (`spine-tick-log.ts`) — every sim-track route, `gmgn-open-sim` and the social cross-check already call it | spine stage `price` -> `failed` (could not price the open); `gate` / `rug` / `size` -> `skipped` with the spine reason. A `pass` is deliberately **not** recorded (see below) |
| `runOpenWithRetry` (`open-attempts.ts`) | each failed try (`is_final=false`), the final thrown failure, and the price-moved skip with both prices |

**Success is read from `sl_tp_positions`** (`is_simulation = true`, created in the window), not from a row written at
the spine: a spine `pass` is followed by sizing, cap and insert steps that can still stand down, and calling it a
success would overstate. `success% = opened / (opened + failed)`; skipped-by-brake is reported next to it, not inside it.

> **Not wired yet (waits for #138):** the *route-level* skips — "at cap", the live-mcap-range brake, the family
> gates — are decided in the four sim-track routes and `open-strategy-sim-positions*.ts`, which PR #138 owns. Until it
> merges they leave only their existing `skipped.push` / log lines. After #138: call
> `recordOpenAttempt({ outcome: 'skipped', stage: 'gate', reason })` at each (one line each), and
> `outcome: 'success'` after the insert if an explicit success row is wanted.

## 2. Failed-open policy (`OPEN_RETRY_POLICY=1`)

Implemented inside `prepareTargetMachinePaperOpen`, the shared open spine, so every caller gets it with no route edit.

- **Retryable:** the try threw, or the spine could not price it (`stage: 'price'`).
- **Not retried:** a rug / size stand-down — that is a decision, not a failure.
- Up to `OPEN_RETRY_MAX` (2) retries, `OPEN_RETRY_DELAY_MS` (1500) apart. Each retry re-reads the spot price
  (`refetchPriceUsd` if the caller passes one, else the shared Jupiter market hints) and opens at the **fresh** price.
- Before a retry: `|fresh − price at the last failed try| / last > OPEN_RETRY_MAX_MOVE_PCT` (5) -> **fail loudly and skip**:
  `log.error`, a final `failed` row with reason `price_moved_gt_5pct` and both prices, and the spine returns
  `{ ok: false, stage: 'price', reason: 'price_moved_gt_5pct' }`. Exactly 5 % still retries.
- Each retry is compared with the **previous** failed try, not the first.
- Exhausted retries: a thrown error is re-thrown (callers already handle it), a price failure is returned as before.

## 3. The reporter (`/api/operations/open-report`, cron `open_report`, default hourly)

`OPEN_REPORT_ENABLED` (default **on**) — posts through `sendTelegramAlert` to `TELEGRAM_ALERT_CHAT_ID`; when
Telegram is not configured the tick answers `{skipped:true}` and posts nothing.

| Part | Flag (default) | What |
|---|---|---|
| Hourly | `OPEN_REPORT_HOURLY` (on) | last-1h opened / failed / skipped, success % and fail %, top reasons |
| Daily | `OPEN_REPORT_DAILY` (on), `OPEN_REPORT_DAILY_HOUR_WIB` (8) | same for 24 h |
| Alerts | `OPEN_REPORT_ALERTS` (on) | below |

Alerts, each with its own cooldown in `watchdog_alert_state` (stamped only after a delivered send, so a failed send retries):

- **At cap, no opens for 6 h** — a *hook*: `registerOpenStallProvider({name, check})`. #138's `cap-stall-monitor` registers
  here after it merges. Until then no provider exists, so the alert cannot fire (the report still shows 0 opens).
  6 h cooldown.
- **Stuck job lock** — a `bot_job_locks` row not expired but held longer than `OPEN_REPORT_STUCK_LOCK_MIN` (45) min, i.e.
  still being renewed by a job that is not finishing. `OPEN_REPORT_LOCK_IGNORE` = comma list of legitimately long jobs.
- **Stale data feeds** — newest 1m bar older than `OPEN_REPORT_STALE_BARS_MIN` (15), mcap tracker older than
  `OPEN_REPORT_STALE_TRACKER_MIN` (30), last completed copier sweep older than `OPEN_REPORT_STALE_COPIER_MIN` (45). A feed that
  cannot be read (table absent) is logged, not paged.

`POST …/open-report?dry=1` returns the texts without sending or touching cooldowns; `?mode=hourly|daily|alerts|auto`.

## Ship

1. Apply `db/init/65-position-open-attempts.sql` **before** the code (additive, idempotent). Without it recording
   pauses itself for 10 min after the first failure and the report prints a one-line warning.
2. If PR #151 (default API tier = wallet) has landed, add `/api/operations/open-report` to `SELF_AUTH_API_PREFIXES`
   (`src/config/api-access.ts`), otherwise the proxy 401s the cron.
3. Deploy web + cron. Reporting starts on its own; `curl -X POST '…/api/operations/open-report?dry=1&key=…'` previews it.
4. `OPEN_RETRY_POLICY=1` only when ready to change behaviour.
