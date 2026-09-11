# Regime climate gate (S5)

Thin client for shared BTC regime climate, vendored in ReloadSOL because this
repo cannot depend on `@btc/shared`. Payload and helpers match
btc-sentiment-terminal `docs/CONSUMER.md` (`interpretClimate` / `sizeHint`) and
the Cloudflare `rh-tape-bot` climate gate.

**This scaffold is paper / read-only first. Do not enable live force without an
explicit ask.** No VPS deploy is part of this change.

## Enable

Default **off**. Optional keys (commented in `.env.docker.example`):

| Variable | Default | Meaning |
|---|---|---|
| `CLIMATE_GATE` | unset/off | `1` / `true` enables the gate on **paper / `dry_run`** DLMM opens |
| `CLIMATE_GATE_LIVE` | unset/off | `1` / `true` also applies the gate when `dry_run=false`. **Ask before setting.** |
| `CLIMATE_FAIL_CLOSED` | unset/off | `1` treats climate fetch errors as stand-down (block). Default is **fail-open** (scale 1) |
| `CLIMATE_URL` | `https://terminal.reloadsol.app/api/regime/climate` | Override the climate endpoint |
| `CLIMATE_CACHE_MS` | `30000` | In-process cache TTL |

Paper-safe example:

```bash
CLIMATE_GATE=1
# CLIMATE_GATE_LIVE=1   # do not set unless confirmed — live LP size would be forced
# CLIMATE_FAIL_CLOSED=1
```

Events are logged as `console.info('[climate_gate]', <json>)` with `action`
`evaluate` / `blocked` / `skipped_live`.

## What it does

- Fetches climate (~30s cache), interprets `state` → `sizeHint` (**Cash=0 … Hype=1**).
- Cascade / news veto **caps ≤ trim** (0.25) in `interpretClimate`, matching `@btc/shared`.
- On DLMM **new risk** (opens / size-up): **stand-down or cascade/news veto blocks**
  the open; otherwise amount is scaled by `sizeHint`.
- **Kill switch, daily-loss, capital caps, and `DLMM_AGENT_ENABLED` always win** —
  climate never increases size and never unpauses the agent.
- Closes / Healer `REDEPLOY` of existing size are **not** gated (reduce-risk stays allowed).

Wired paths:

- Solana DLMM deploy — `deployPosition` (`/api/dlmm/positions`, `/api/dlmm/sim-track`, Telegram `/deploy`)
- Robinhood paper LP opens — `rh_lp_screen` (`openPaperPositions`)

## Ownership split

| Owner | Surface |
|---|---|
| btc-sentiment-terminal / `@btc/shared` | Climate API + `interpretClimate` / `sizeHint` semantics |
| rh-tape-bot-cf | Cloudflare vendored gate (pattern this module mirrors) |
| **reloadsol (this file)** | DLMM paper/live flag + logging only |
| buy_bulk | **Not in this repo** — see TODO in `src/utils/climateGate.ts` |
| S6 observe | Separate; this PR does not wait on it |

## Ask before live

`CLIMATE_GATE=1` does **not** change live (`dry_run=false`) size. Live application
requires `CLIMATE_GATE_LIVE=1` after an explicit confirmation. Do not deploy this
flag from an agent run.
