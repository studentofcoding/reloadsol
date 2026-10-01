# SPEC — the batch swap lane: Raptor build, a simulation guard, Shyft-RPC landing v1

**Status:** implemented, shipping (2026-10-02) — B1-B5 landed; B6 live verify in flight
**Date:** 2026-10-02
**Surface:** `src/utils/jupiter.ts` (`executeBulkBuy` / `executeBulkSellAlt`), `src/utils/swap-executor.ts` (guard + landing), `src/utils/shyft-transaction.ts` (RPC send), `src/utils/solana.ts`/`src/utils/rpc-urls.ts` (RPC list)
**Lane:** Solana bulk buy/sell only. The **direct (1-to-1) swap is explicitly out of scope** — §3 says why.
**Depends on:** `src/utils/solanatracker-raptor.ts` (build), `src/utils/sol-desk-signer.ts` (server sign), Shyft JSON-RPC
**Provenance:** three live batch runs on prod, 2026-10-02, plus the read-only single-pair comparison. Every number below is measured, not modelled.

---

## 1. Goal

Make the **batch** swap fast without giving up safety: build all legs in one parallel round on Raptor's ungated lane, refuse to sign anything that would revert, and land through the Shyft RPC in a paced sequence.

Today a 5-token bulk buy spends **~14.87 s** in prepare alone — five keyed Jupiter `/order?taker=` calls serialised behind the 0.5 rps trade lane (`docs/SWAP_AND_CLOSE_FLOW.md:84`).

## 2. Evidence (measured)

### 2.1 Raptor's win is concurrency, not latency — this is the whole decision

| N | Raptor | Jupiter keyed | winner |
|---|---|---|---|
| **1 (direct)** | 688 ms build | **206 ms** build | **Jupiter 3.3×** |
| **5 (batch)** | **832 ms wall** (one parallel round) | ~10,000 ms (5 × 0.5 rps) | **Raptor ~12×** |

A single Raptor build is *slower* than a single `/order`. Raptor wins only by parallelising past the gate, and at N=1 there is no gate to beat. **§3 locks the direct swap to Jupiter on this basis.**

### 2.2 A Raptor build can be unexecutable where Jupiter's is clean

Read-only, single pair, both lanes built and simulated:

```
DEW -> SOL   raptor 688ms  cu 92686   clean
DEW -> SOL   jupiter 206ms cu 146572  clean
DEW -> BPX   raptor 1024ms cu 58445   {"InstructionError":[4,{"Custom":6006}]}   <-- reverts
DEW -> BPX   jupiter 242ms cu 159976  clean
JD8K -> SOL  raptor 643ms            500 "No multi-hop route found"
JD8K -> SOL  jupiter 51ms            500 "Something unexpected occurred"
```

`Custom 6038` (batch, two mints) and `Custom 6006` (this pair) are the same class: **a Raptor build that returns a transaction which cannot land.** Jupiter has no equivalent because `/order` refuses up front. Retrying at a wider hop ceiling does **not** fix it — forcing `maxHops=3` on all five legs reproduced exactly the same two failures, so the hop policy (T5/T17) is not implicated and these are mint-specific.

### 2.3 Landing: three lanes, same prepared batch

| lane | result | confirm |
|---|---|---|
| `send_many_txns` (REST) | **417**, 1 of 3 landed | **61 s** |
| Shyft RPC `sendTransaction` — parallel | 2 of 3 (one `RateLimitExceeded`) | 1.8 s |
| **Shyft RPC `sendTransaction` — serialised** | **3 of 3 CONFIRMED** | **163 ms** |

Shyft's own docs say `send_many_txns` returns **per-transaction** results (`[{id, signature, status}]`). We only ever received the top-level `{"success":false,"error":"failed to send the transaction on blockchain"}` — it failed before per-tx reporting, which is how it hid a partial batch. It also takes an optional `commitment` we were not sending.

### 2.4 The Shyft RPC is a better RPC than the one we run

| | Shyft RPC | `SOLANATRACKER_RPC_URL` (measured 2026-10-01) |
|---|---|---|
| latency | **0.12–0.28 s** | ~0.2–0.24 s |
| burst tolerance | **10/10 OK** | 6 at once → **0 ok, 6× 429** |
| JSON-RPC batch | **accepted** (array returned) | capped at 10, counted per call → useless |

### 2.5 The end-to-end batch, run 4

```
1 prepare (Raptor, ONE round)        832ms  5 built
2 guard   (simulate-and-drop)        149ms  kept 3, dropped 2 (6038)
3 sign    (server keypair)            54ms  for 3
4 land    (Shyft RPC, serialised)   1554ms  3/3 signatures, no errors
5 confirm                            163ms  3/3 CONFIRMED
SOL 0.051984171 -> 0.052885728 (+0.000902)   three legs sold
```

**~2.75 s for 5 legs**, against 14.87 s of prepare alone today.

### 2.6 Price, for the record

Buys: **median −1.6 bps** vs Jupiter (21 of 29 priced pairs within ±10 bps). Sells: Raptor measured **−107 bps mean / −350 worst**. So the batch move is price-neutral on the buy side and a real cost on the sell side — which is another reason the direct/large swap stays on Jupiter (§3).

## 3. Locked decisions

| Decision | Lock |
|---|---|
| **Direct (1-to-1) swap** | **Stays on Jupiter** — `/order?taker=` → `/execute`. Faster at N=1, carries the affordability simulation, and price-competitive-or-better on sells. **Not in scope for this change** |
| **Batch (N > 1)** | **Prepare on Raptor in one parallel round.** This is the only place the concurrency win exists |
| **Simulate-and-drop guard** | **Mandatory before signing.** Free (~150 ms), and the only thing standing between an unexecutable build and a burned fee. One bad leg must never poison a batch again |
| **Batch landing** | **Shyft RPC `sendTransaction`, serialised behind a min-interval gate.** Never parallel (`RateLimitExceeded` at 3), never `send_many_txns` as the primary |
| `send_many_txns` | **Demoted to fallback** — it reported a blanket failure and landed 1 of 3 while claiming nothing about the rest |
| Raptor's send path | Unchanged: **our RPC only**, per §3 of `SPEC-swap-provider-routing-v1` |

## 4. Implementation tasks

- [x] **B1 — simulate-and-drop guard in the batch landing path. DONE.** `dropRevertingPreparedSwaps`
      (`swap-executor.ts`) simulates every built tx before signing and drops the ones that revert, wired into
      `executeBulkBuy` between build and land; dropped legs report as `Would revert on chain: …` per token.
      **Fails open on purpose** — only a simulation that *returns* an error drops a leg; one that cannot run
      (transport/rate limit) keeps it, because silently discarding a good trade is worse than the fee it saves.
      3 tests, including that distinction.
- [x] **B2 — Shyft RPC for the BATCH only. DONE.** `SHYFT_RPC_URL` read by the batch landing alone (`shyftBatchRpcUrl`); the single-swap path and all reads keep their existing lanes, per the request. Documented in `.env.docker.example`. Unset = old behaviour, byte for byte.
- [x] **B3 — paced batch landing. DONE.** `sendBatchViaShyftRpc` sends one `sendTransaction` at a time, spaced by `BATCH_SEND_MIN_INTERVAL_MS` (default 400), and **never in parallel** — a test asserts `maxInFlight === 1`. A rejected or throwing leg yields `null` for that leg only and does **not** abort the batch; those resolve through the existing per-tx RPC fallback. `send_many_txns` stays as the fallback lane.
- [x] **B4 — batch prepare on Raptor. DONE.** `prepareBulkSwapTransaction(params, { lane: 'raptor' })` reuses the existing `prepareRaptorSwap` (no new build code); both bulk call sites (buy `jupiter.ts:1915`, sell `:2756`) request it. It throws → the keyed builder runs instead, so the change degrades to today's behaviour and never to nothing.
- [x] **B5 — tests. DONE.** 8 new: the guard (drops a reverting leg, keeps the rest, **fails open** when a simulation cannot run) and the batch lane (unset → `null`, one signature per leg, **never parallel**, one rejected leg does not abort the batch, a transport throw is a per-leg miss).
- [ ] **B6 — live verify.** A real 5-leg batch on prod: guard drops the known-bad leg, the rest land, per-phase timings reported.

## 5. Env

| Var | Status | Note |
|---|---|---|
| `SHYFT_RPC_URL` | **added** | Shyft JSON-RPC (`https://rpc.shyft.to?api_key=…`). Faster, burst-tolerant, accepts JSON-RPC batches — see §2.4 |
| `BATCH_SEND_MIN_INTERVAL_MS` | **added** | Serial spacing between batch sends (default 400). Parallel sends drew `RateLimitExceeded` at 3 |
| `RAPTOR_TOKEN_TOKEN_HOPS` / `RAPTOR_MAX_HOPS` | unchanged | The hop ceiling is **not** implicated in the reverting builds (§2.2) |

## 6. Non-goals

- **The direct (1-to-1) swap.** Locked to Jupiter (§3).
- **Fixing the reverting builds.** `6038` / `6006` are Raptor-side; the guard makes them harmless rather than fixing them. Worth reporting upstream with the two mints.
- **The unbounded tx history gap.** Shyft's own docs: transaction history is limited to the last 3–4 days on both their RPC and APIs.
- **Replacing the primary RPC for reads.** The Shyft RPC is faster and more permissive, but swapping the read lane is a separate decision with its own blast radius.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Raptor returns a reverting build we don't catch | The guard simulates everything before signing; a sim error = drop, never sign |
| All legs dropped → an empty batch | Report it as a per-token failure, not a silent no-op; the existing per-token result shape already carries this |
| Shyft RPC rate-limits under a real burst | Paced by `BATCH_SEND_MIN_INTERVAL_MS`; on `RateLimitExceeded` retry that tx on the existing RPC path |
| A Raptor round fails entirely | Fall back to the current keyed prepare — the change must degrade to today's behaviour, never to nothing |
| Price on sells | Batch buys are parity; sells are −107 bps mean. If a batch sell's measured price is materially worse than the keyed lane, that is a reason to keep **sell** batches on Jupiter even while buys move |

## 8. Verification

1. `npm run lint && npm run verify:no-raw-useeffect && npm run verify:no-hardcoded-sol-price && npm run build` clean.
2. Unit tests for B5 green, including a regression that the **direct** swap path still builds via Jupiter.
3. Live: a real 5-leg batch on prod with the known-bad mint present — assert the guard drops it, the survivors `CONFIRMED`, and report prepare/guard/sign/land/confirm per phase (target ≈ §2.5's ~2.75 s vs 14.87 s today).
4. Re-run the read-only single-pair comparison to confirm the **direct** swap still takes Jupiter at ~206 ms.
