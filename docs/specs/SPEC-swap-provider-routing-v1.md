# SPEC — Swap provider routing: measure through to an unsigned tx, keep a best-of set v1

**Status:** **partially implemented (2026-10-01)** — the two live defects are fixed and gated; everything else is still to-spec
**Date:** 2026-10-01
**Surface:** `src/utils/token-transfer-fee.ts` (new), `src/utils/jupiter-swap-quote.ts`, `src/utils/swap-executor.ts`, `src/utils/jupiter-lite-swap.ts`, `src/utils/solanatracker-raptor.ts`, `src/utils/swap-quote-parallel.ts`, `src/utils/swap-quote-pick.ts`, `src/utils/jupiter-ultra.ts` (delete)
**Lane:** execution / infra
**Depends on:** `JUPITER_API_KEY` (present in prod), `api.jup.ag/swap/v2`, `lite-api.jup.ag/swap/v1`, `raptor-beta.solanatracker.io`, `dev-quote-api.dflow.net`
**Provenance:** read-only benchmark runs inside `reloadsol-web` on `flowey-vps`, 2026-10-01. Figures and the full tables: `docs/diagrams/13-swap-providers.html`

No new external dependency is adopted. Every lane below is either already wired in this repo or is a
provider evaluated and **rejected** with evidence.

---

## 0. Verdict

**One lane: `GET /swap/v2/order?taker=` → simulate → sign → `POST /swap/v2/execute` → verify on-chain.**
No fan-out, no per-direction lane switching, no routing on price.

| step | call | why it is there |
|---|---|---|
| prepare | `GET /swap/v2/order?…&taker=&slippageBps=` (keyed) | returns quote **+ unsigned tx + `requestId`** in one call, and it **simulates** — a wallet that cannot pay gets `errorMessage: "Insufficient funds"` with an empty `transaction` |
| simulate | `connection.simulateTransaction(tx)` | an independent pre-flight against the state you are about to submit to; routes drift between builds (§2.7) |
| sign | wallet keypair | — |
| execute | `POST /swap/v2/execute` `{signedTransaction, requestId}` | Jupiter's managed landing — the only finish line that exists: Lite has no `requestId`, Raptor's sender does not broadcast (§2.9) |
| verify | balance **and** signature on-chain | **never** a provider's response body — a signature is not a landing |

Measured: **3/3 landed, ~668 ms on-chain, ~888 ms end to end.**

**Reject outright:** the fan-out (+5 bps mean / 0 median for 2.59×); Raptor as an execution path (0/4
signatures for transactions that never reached the chain); Lite as an execution path (per-IP ban outlasting
10 min, no key can raise it, no simulation, Jupiter cannot finish it); DFlow; swap.io inline; Titan.

**Where the value is:** not routing — that is ~5 bps. It is (a) the unlandable-transaction class
(§2.7, transfer-fee mints), (b) provider "sent" that never landed (§2.9), (c) an explicit priority fee,
(d) confirming on-chain. Lite = estimates. Raptor = quoting (294/294 at 5 rps, p50 199 ms), never sending.

## 1. Goal

Decide which swap provider each lane should use, measured *through to an unsigned transaction* on
production rather than taken from docs, and prove that each lane's output is actually signable.

## 2. As-built / evidence (measured 2026-10-01)

Run inside `reloadsol-web` (prod egress + prod `JUPITER_API_KEY`), taker = the live wallet
`3V3N5xh…`, mints from `trading_records` (12-day window) + SOL/USDC/BONK, ~$50 notional,
`slippageBps=100`. **Read-only: `/order`, `/quote`, `/swap` (build) and `/quote-and-swap` only —
nothing signed, nothing broadcast.** Isolated passes (20 s idle, 1.2 s spacing) so no provider's
limiter touches another's numbers.

### 2.1 Latency to an unsigned tx, p50 ms (single swap)

| pair | Jupiter `/swap/v2/order` | Jupiter lite `/quote`+`/swap` (2 calls) | Raptor `/quote-and-swap` (maxHops=3) | DFlow `/order` |
|---|---|---|---|---|
| DEW→BPX | 214 | **51** | 275 | 245 |
| DEW→SOL | 209 | **39** | 194 | 241 |
| SOL→DEW | 217 · *no tx* | **36** | 191 | 242 |
| DEW→USDC | 211 | **40** | 189 | 243 |
| USDC→DEW | 214 | **35** | 191 | 246 |

**The two-call Lite lane is 5–6× faster than any single-call `/order`, and it still returns a
transaction.** The ~200 ms on `/order` is not the cost of building a tx — it is the cost of the
simulation `/order` runs (see §2.4). `lite→tx` was also the only lane to return a tx on **all five**
pairs.

### 2.2 Batch, 5 real mints (sum of 5 sequential calls, ms)

| lane | 5× token→SOL | 5× SOL→token | returned a tx |
|---|---|---|---|
| Jupiter `/swap/v2/order` | 1126 | 1107 | 2/5 · 0/5 |
| **Jupiter lite `quote`+`swap`** | **192** | **187** | **5/5 · 5/5** |
| Raptor `quote-and-swap` | 1785 | 1345 | 5/5 · 5/5 |
| DFlow `/order` | 1724 | 1231 | 5/5 · 5/5 |

The Raptor/DFlow sums carry one cold call each (~630 ms / ~743 ms); their warm per-call cost is
~195 ms and ~245 ms.

### 2.3 Price — every source fired together, same moment, 5 rounds

Average gap behind the best available quote across the 5 pairs (0 % = best):

| source | avg behind best | note |
|---|---|---|
| swap.io → best of its set | **−0.370 %** | a pick, not a provider |
| swap.io → jupiter entry | −0.433 % | |
| Jupiter lite `/quote` | −0.524 % | |
| Raptor `/quote` | −0.655 % | **wins 2 pairs outright, loses 1 badly** |
| Jupiter `/order` (taker) | −0.714 % | |
| Jupiter `/order` (no taker) | −0.714 % | identical — taker scoping does not change the quote |
| DFlow `/quote` | −1.039 % | |

Per pair, the winner changes — which is the point:

| pair | winner | Raptor vs Jupiter |
|---|---|---|
| DEW→SOL | **Raptor** | **+0.55 %** |
| DEW→USDC | **Raptor** | **+1.31 %** |
| SOL→DEW | Jupiter lite | −0.78 % |
| BONK→SOL | Jupiter lite | −0.05 % |
| DEW→BPX | Jupiter (via swap.io) | **−2.41 %** |

**No single provider is best.** Raptor is materially better when selling an illiquid memecoin into
SOL/USDC (+0.55 % / +1.31 %) and materially worse on a token→token route into BPX (−2.41 %). A
best-of pick is worth more than any one provider.

### 2.4 `/order` answers 200 with an empty transaction

For SOL→DEW and BONK→SOL every Jupiter `/order` host returned **HTTP 200 with an empty
`transaction`** plus `errorMessage: "Insufficient funds"` / `errorCode: "InsufficientFunds"` —
the wallet does not hold the input token. A different taker returns a full tx on the same request.
The Lite `/swap` build does **not** pre-check the payer and returns a tx regardless.

Consequence: **`200 OK` is not success for `/order`.** `prepareJupiterSwapOrder` already throws when
the tx is missing, but that check is load-bearing and must not be relaxed (see T3).

### 2.5 Every lane's tx actually decodes

19/19 transactions decoded with `@solana/web3.js`: all **v0**, exactly **1 signature** required, and
**fee payer = the taker** in every case. All four lanes hand back genuinely signable unsigned
transactions.

### 2.6 Providers researched

| Provider | Verdict |
|---|---|
| **SolanaTracker Raptor** (`raptor-beta.solanatracker.io`) | **Keep** — already wired; keyless; 1 call to tx; best price on 2/5 pairs; 6/6 parallel with no 429. `maxHops=1` (our default) fails with `No direct route found` on DEW→BPX — `maxHops=3` fixes it. |
| **DFlow** (`dev-quote-api.dflow.net` keyless / `quote-api.dflow.net` keyed) | **Reject for now** — worst price of the measured set (−1.04 % avg), 1 call to tx but ~245 ms, and its `transactionVersion=v1` mode cannot be signed by `@solana/web3.js` (needs `@solana/kit`), so we would be pinned to its legacy path. |
| **swap.io** (`swap.io/internal-api/routhex/swap/quote`) | **Reject as an execution lane, keep as a measurement tool** — keyless POST, returns Autobahn + OKX + Jupiter + DFlow quotes in **one** same-moment call (~0.23–1.35 s), and its best-of lands −0.37 % vs true best. But no build/swap endpoint was found (404 on `/swap`, `/build`, `/swap/build`, `/order`), so it cannot produce a transaction. |
| **Titan** (`titan.exchange`, `us1.api.demo.titan.exchange`) | **Not evaluable** — API key required; the demo host exists (404 at root) but no keyless quote path. Meta-aggregator that aggregates other aggregators. |
| **`0dotxyz/solana-dex-superagg`** | **Reference only** — a Rust library wrapping Jupiter + Titan + DFlow behind a `BestPrice` strategy. It is not a provider, it is the same best-of idea in a language we do not ship. |

### 2.7 Real round trip on mainnet (VPS, 2026-10-01)

Sell 15 DEW → SOL, then buy 15 DEW back, both through the Lite lane. **Both transactions finalized,
`err=None`.** Cost of the whole round trip: 0.000382 SOL + 0.005 DEW ≈ **$0.046**, almost entirely the
two priority fees.

| phase | leg 1 (sell) | leg 2 (buy back) |
|---|---|---|
| quote | 44.6 ms | 25.9 ms |
| build | 24.5 ms | 15.5 ms |
| simulate | OK · cu 118,310 | OK · cu 38,733 |
| sign | 26.3 ms | 6.2 ms |
| send | 52.9 ms | 28.5 ms |
| **confirm to finalized** | **5,044 ms** | **1,692 ms** |
| total | 5,268 ms | 1,801 ms |

**Four things only a real run could show:**

1. **DEW carries a 1 % Token-2022 transfer fee** (`transferFeeConfig`, 100 bps). At
   `slippageBps=100` the fee consumes the entire tolerance and the router's own post-check fails with
   `6001 SlippageToleranceExceeded` — the tx builds in 21 ms and can never land. At 300 / 500 / 1000 bps
   the identical route simulates cleanly. This is a **token class**, not one mint.
2. **Only `/order` catches it before sending.** Simulating the same swap across all three lanes: Lite
   and Raptor return a tx that fails simulation; `/order` refuses server-side. That is what its ~200 ms
   buys.
3. **Without a priority fee the tx never lands.** First live attempt: broadcast, `getSignatureStatuses`
   → `null`, balances unchanged. With 150,000 lamports it landed both ways.
4. **The route is not stable between attempts** — the same sell produced Manifest, then
   Meteora DLMM + Kipseli. Simulate the transaction you are about to send, never an earlier build.

**And prepare is 1–10 % of a real swap.** Confirmation is 96–99 % of it, so a lane that wins the
prepare race by 180 ms is optimising the wrong 2 %.

### 2.8 Lite's rate ceiling, probed

| probe | result |
|---|---|
| Parallel burst | 1 → 32 concurrent all **200**; 32/32 in 105 ms (≈305 rps) |
| Sequential back-to-back | 30 in 397 ms = **75.5 rps attempted, 30/30 OK** |
| Then | after ~93 requests in ~30 s: **429 for ~120 s**, still 429 at one request every 10 s |
| Sustained after recovery | 4.0 / 2.0 / 1.0 rps → **12/12 OK each**, p50 13 ms |

So there is no tunable "highest TPS": it absorbs a large burst and then **locks the IP out for about
two minutes**, during which even a trickle is refused. Keyless, per-IP, and no API key can raise it.

### 2.9 Rate-limited back to back, and the lane-combination question

Each lane driven at its own budget for 60 s, concurrently, DEW pair, alternating directions:

| lane | sent (achieved) | OK | 429 | p50 | p95 | max |
|---|---|---|---|---|---|---|
| Jupiter `/order` (0.5 rps cap) | 31 (0.52 rps) | 29 | **2** | 215 ms | 245 ms | 283 ms |
| Raptor quote-and-swap (5 rps cap) | 294 (4.90 rps) | **294** | 0 | 199 ms | 214 ms | 616 ms |
| Lite quote+build (1 rps) | 61 | **0** | 61 | — | — | — |

Raptor is clean at its cap; Jupiter's documented "0.5 rps clean" is the **boundary**, not comfortably
inside it (2 × 429 in 60 s). Lite could not be measured — the IP was still serving its lockout, which in
this case outlasted **10 minutes**, a 150 s cooldown, and 1 rps. The same request from another IP
returned 200 and attaching our key changed nothing: **per-IP, and not liftable**.

**Can a Lite prepare be finished by Jupiter or Raptor?** Tested with real mainnet transactions, every leg
simulated first:

| combination | possible | result |
|---|---|---|
| Lite prepare → Jupiter `/execute` | **No** | `/execute` needs the `requestId` only `/order` issues |
| Lite prepare → Raptor `/send-transaction` | accepted | 200 + signature in ~195 ms, **never on-chain — 0/3** over 33 s polls |
| **Jupiter `/order` → `/execute`** | **Yes** | **3/3 landed, ~668 ms**, exchange returned `status=Success code=0` |

Verified independently of the client: DEW fell by exactly the amount sold, SOL rose, and the wallet's five
most recent signatures were all `err=None`, every one a Jupiter-executed swap. **No Raptor-broadcast
transaction exists on-chain.**

End to end: Jupiter `/order` → `/execute` ≈ **888 ms**; Lite → our own RPC send+confirm ≈
**1,732–5,084 ms**. Lite wins the prepare phase (~40 ms vs ~220 ms) and loses the swap.

**So: prepare on the lane that can also land it.** Lite cannot finish what it starts, and Raptor's send
path returns a signature for transactions it does not broadcast.

### 2.10 What our implementation already does — and the real diff

Read from `src/utils/swap-executor.ts`, not inferred:

| step | today | vs the proposed flow |
|---|---|---|
| Raptor pre-quote | **absent** — the desk path never quotes Raptor (`collectSwapQuoteCandidates` docstring: "Raptor is not queried") | proposed here, but **not worth adding**: Raptor's best-of edge measured +5 bps mean / 0 median, and its quote does not predict Jupiter's routing. Useful only as a cheap budget pre-filter (5 rps vs 0.5), never as a veto |
| prepare | `/order?taker=` → tx + **`requestId`** + impact, behind `assertSwapImpact` | **already correct** (`prepareJupiterSwapPrepared`, `swap-executor.ts:211`) |
| Lite fallback | on `/order` failure → Lite `quote` + `/swap` | already there — but a Lite tx has no `requestId`, so it can never be `/execute`d and always lands via RPC |
| simulate | **not in the submit path.** All three RPC sends use **`skipPreflight: true`** with `maxRetries: 2` (`swap-executor.ts:506`, `:516`, `:550`) | **deliberate — resolved 2026-10-01.** An earlier draft of this row called it "a real gap" and §2.12 called it "a guardrail"; the reasoning below decides it. Flipping to `false` trades a *possible fee burn* for a *rejected swap*: a tight-but-valid tx that would have landed comes back as a simulation error, and `submitSignedSwap` has **no retry** — so the swap fails outright instead of costing a fee. Landing outweighs the fee here. The residual risk is real but bounded to the **non-Jupiter fallbacks** (Lite/Raptor-built txs have no upstream simulation, unlike `/order`), and is narrowed by the transfer-fee floor plus prepare's own re-quote |
| sign | wallet keypair / server signer | already correct |
| execute | **already first** — `submitSignedSwap` calls `tryJupiterExecute` before Shyft/RPC (`:471`), gated on `prefersJupiterExecute` (`provider === "jupiter_swap" && requestId`) | **already correct.** An earlier claim in this workstream that we never call `/execute` was wrong, and is corrected here |
| batch landing | `tryLandPreparedOnServer` lands a whole batch server-side, but only if **every** item `prefersJupiterExecute` | already there; degrades to per-item RPC if any item is Lite/Raptor-built |
| Raptor send | prod sends Raptor-built txs **via RPC**, not `/send-transaction` (`:496-507`) | the phantom-send finding (§2.9) **does not affect prod today** — `sendRaptorTransaction` is not on the hot path. It is **kept by decision** (§3) and inert while nothing calls it; whoever wires it up must verify on-chain rather than trust the response |
| confirm | `confirmSwapSignaturesBatch`; `checkViaRaptor` only when the tx was Raptor-built | already correct |

**The honest diff is small.** The main path is already `/order → sign → /execute → confirm`. What is
actually missing: a client-side simulate on the non-Jupiter fallbacks, the transfer-fee slippage floor, an
explicit priority fee, and the batch budget work below.

### 2.11b Can N legs be composed into ONE transaction? Measured on both lanes — no.

Asked whether a bulk of N buys could become a single transaction. Measured on prod 2026-10-01 by composing real wallet holdings (token→SOL) and serialising, mirroring the repo's own `flattenLegInstructions`. **Nothing was signed or sent.**

| instruction source | 1 leg | 2 legs | per-leg accounts |
|---|---|---|---|
| Jupiter Lite (thin route) | 522 b | 869 b — fits | — |
| Jupiter Lite (fat route) | 1011 b | **1241 b — over** | 38–64 |
| **Raptor `/swap-instructions`** (free lane) | **952 b** | **serialize throws — over** | 29–39 |

**The lane is not the blocker.** Raptor's instructions are marginally leaner than Jupiter's (29–39 accounts vs 38–64, and no `cleanupInstruction`) — one leg drops 1011 → 952 bytes — but N=2 still overflows 1232. The cost is structural: ~230 bytes per leg even with ALT compression, so five legs ≈ 1,900 bytes, **~57% over**. Compute is a second, smaller wall: the compose attaches compute-budget instructions only to leg 0, so leg 0's own `SetComputeUnitLimit` (measured 115k–245k) becomes tx-wide; overriding it to 1.4M did **not** rescue N=2, because bytes bind first.

ALTs are mandatory rather than a lever — with lookup tables disabled, **even N=1 throws**.

**Conclusion: one transaction is capped at ~2 legs, and only for thin routes.** Five is not reachable by tuning; it would need an on-chain program (which the existing `ponytail:` note in `sol-arb/atomic.ts` also names) or fewer legs per tx.

**Bonus capability:** Raptor exposes **`POST /swap-instructions`** on the free lane (`quoteResponse` from its own `GET /quote`), with a payload shape nearly identical to Jupiter's — so instruction building need not ride the keyed 0.5 rps lane. Worth knowing even though the compose ceiling stands.

### 2.11 The batch — measured, and the one place Raptor wins

`prepareBulkSwapTransaction` (`:986`) prepares **per token** — N tokens means N keyed `/order` calls, and
each then lands through `/execute` for N more. So the gate, not latency, sets the wall time.

**Measured, tokens → SOL, same amounts.** Note the mint lookup resolved **2 of the 5** sampled, so the batch
actually compared is 2 — the per-token cost is the finding, not the batch size:

| path | shape | wall | 429 | txs |
|---|---|---|---|---|
| Jupiter `/order` | sequential behind the 0.5 rps gate | **~2 s per token**, then the same again for each `/execute` — N tokens ≈ 2N seconds, no overlap | 2 (quota drained by this workstream) | 0 |
| Raptor `quote-and-swap` | both fired together | **644 ms total** (slower of the two: 642 ms) | 0 | 2/2 |

**Raptor concurrency ramp — "free to use with no rate limits" is accurate:**

| concurrent | 1 | 5 | 10 | 20 |
|---|---|---|---|---|
| OK | 1/1 | 5/5 | 10/10 | **20/20** |
| 429 | 0 | 0 | 0 | **0** |
| wall | 195 ms | 636 ms | 620 ms | **641 ms** |

Twenty concurrent builds in 641 ms with no rejection is a different regime from a 0.5 rps gate. **Raptor's
preparation is 10–20× the throughput Jupiter's quota allows — that, not price, is the argument for it.**

**But the landing half is still broken, re-tested with better instrumentation.** A Raptor-built tx
simulated clean (cu 78,367), `/send-transaction` returned **HTTP 200 + a signature in 190 ms**, and then
Raptor reported `pending` while the chain reported **not found** on all eight polls over 16 s. That is now
**five** accepted Raptor sends, none on-chain. Likely mechanism, from Raptor's own docs:
`/send-transaction` sends via **Yellowstone Jet TPU**, which is a self-host flag
(`--enable-yellowstone-jet`) — a hosted instance with it off accepts, queues, and never broadcasts.

**Bulk verdict — a risk trade, not a price one.** Raptor prepares a batch in one parallel round (~0.64 s for 20 concurrent) where Jupiter needs ~2 s *per token* and then the same again to land each,
but a Raptor tx carries no `requestId`, so nothing can `/execute` it: it lands through our own RPC
(1.7–5.0 s each measured) with **no server-side simulation** to catch the transfer-fee class (§2.7).
**If bulk throughput matters, the honest lever is the Jupiter quota, not the lane.** Use Raptor for bulk
preparation only after the sim + chain-verify guards exist.

### 2.12 Implemented (2026-10-01)

Only the two live defects were fixed. The architecture was left alone because it measured right.

| file | change |
|---|---|
| `src/utils/token-transfer-fee.ts` **(new)** | Reads a mint's `transferFeeConfig` extension and returns the basis points in force for the current epoch. Tolerates both the flat and nested `jsonParsed` shapes, caches for `SWAP_TRANSFER_FEE_CACHE_MS` (default 10 min), 1.5 s read timeout, **fails open to 0**. `applyTransferFeeFloor` raises slippage to `fee + margin` and **never lowers** it; the `-1` Auto sentinel passes through untouched so `resolveAutoSlippageBps` keeps owning it. |
| `src/utils/swap-executor.ts` | `prepareSwapTransaction` applies the floor **once**, before dispatch, so `/order`, the Lite fallback and the arb/Raptor path all inherit it. No-op for classic SPL mints (nearly every swap). `prepareDeskSwap` now **rethrows a venue refusal** instead of falling back to Lite. |
| `src/utils/jupiter-swap-quote.ts` | `JupiterSwapQuoteError.venueRefused` — a 200 carrying `errorMessage` is a venue decision, distinguishable from a transport fault. |

**Deliberately unchanged:** `skipPreflight: true` on the RPC sends — **decided, not deferred** (§2.10): preflight
turns a tight-but-valid tx into a *rejected swap* rather than a landed one, and `submitSignedSwap` has no
retry, so the fee a skipped preflight might burn is cheaper than the swap it might lose; Raptor's unused send
path (latent, off the hot path — audited as **zero callers** under T13); and everything in §3's rejected list.

**Verification actually run:** `npm run verify:no-raw-useeffect` ✓ · `npm run verify:no-hardcoded-sol-price` ✓ · `npm run build` ✓ (compiled, 225/225 pages, `next-env.d.ts` restored by postbuild) · 18 new tests ✓ · all **48** pre-existing swap tests still pass, including the one asserting a **500 does fall back to Lite** — the behaviour deliberately preserved.

## 3. Locked decisions

**Locked 2026-10-01. This is the architecture as built** — the measurements behind each line are in §2.

| Decision | Lock |
|---|---|
| Execution lane | **One lane: keyed Jupiter `/order?taker=` → simulate → sign → `/execute` → verify.** The only lane with a quota tied to our account *and* a pre-flight simulation that refuses unaffordable swaps. No fan-out, no best-of |
| Estimate lane | **Raptor first**, through the shared quote engine (`purpose: 'estimate'`), escalating to the Jupiter picker on Raptor error or a failed impact gate. Ungated, and it answers a whole batch in under a second. The estimate lane is **not** Lite |
| Raptor's role | **Kept, deliberately — three jobs.** (1) the estimate lane above; (2) the arb / `maxHops` swap path; (3) its **send path stays in the tree** (`sendRaptorTransaction` + `/api/solanatracker/send`) even though nothing calls it today. Keeping the code is the decision; **trusting its response is not** — `/send-transaction` returned `200` **plus a signature** for transactions that never reached the chain (T13), so anyone who wires it must verify on-chain first |
| Lite's role | **Display / fallback only, never execution.** A Lite tx has no `requestId`, so `/execute` can never finish it, and its penalty is a **per-IP ban**, not a throttle — an API key does not raise it |
| Fan-out / best-of | **Rejected on measurement**, not on taste: **+5.0 bps mean / 0 median** over 40 random mints for **2.59×** the swap time. `pickBestSwapQuote` keeps its ranker, but is handed one candidate by design |
| DFlow | **Do not adopt** — worst measured price + a tx format we cannot sign with our current client |
| Titan | **Do not adopt** — key required, no keyless path to evaluate |
| swap.io | **Do not put on the execution path** — no build endpoint. Optionally use it as a monitoring source, never as a dependency |
| Ultra | **Delete** — deprecated, equivalent to Swap V2 on every measure, and our wrapper never worked (POST to a GET-only route) |

## 3b. Optimal scenario (recommended) — ⚠️ SUPERSEDED, do not implement

**This section proposed the fan-out, and the fan-out was then measured and rejected** (§2.8: +5.0 bps mean /
0 median over 40 random mints, for 2.59× the swap time). It is kept as the record of what was proposed and
why it lost — **not as a plan.** The shipped architecture is §3 above.

One change, no new dependency, and **no added wall time**.

**Fire the two paying candidates in parallel, keep Lite as the estimate lane, and use `/order`'s
transaction as the affordability gate.**

| Stage | Lanes | Why |
|---|---|---|
| Fan out | `GET /swap/v2/order?taker=` ∥ `POST raptor /quote-and-swap` (maxHops ≥ 3) ∥ `GET lite /quote` | wall time = max(214, 191, 16) ≈ **214 ms** — the same as today's single call |
| Gate | drop candidates whose absolute impact exceeds `SWAP_QUOTE_MAX_IMPACT_PCT`, and drop failures | existing `passesImpactGate` |
| Abort | `/order` returned **no `transaction`** ⇒ abort the swap | the only simulation we have; a wallet that cannot pay must not build |
| Pick | highest `outAmount` | existing `pickBestSwapQuote`; ties already prefer Raptor |
| Build | sign the winner → `/execute` (Jupiter) or `/send-transaction` (Raptor) | per-provider submit, both already implemented |
| Estimate | Lite `/quote` + the existing `JUPITER_QUOTE_CACHE_MS` cache | never executes |

Measured effect on the five-pair set: captures **+0.55 %** (DEW→SOL) and **+1.31 %** (DEW→USDC), and
pays **none** of Raptor's −2.41 % on DEW→BPX because Jupiter wins there.

Rejected alternatives:

- **serial `/order` → Raptor** — ~405 ms and still only one price. Consulting Raptor when `/order`
  *fails* is not the same as consulting it when `/order` is merely *beaten*.
- **Lite as the execution lane** — ~39 ms and it does reach a tx, but it cannot validate, and its
  keyless per-IP ceiling cannot be raised with a key.
- **swap.io inline** — no build endpoint, 0.7–2.6 s wall (the slowest lane measured), and it omits
  Raptor. Offline/monitoring comparison only.
- **DFlow** — worst price, and an un-signable tx format.

Residual risk: the fan-out doubles the number of quote calls per swap (T5c).

## 4. Implementation tasks

- [x] **T1 — delete the dead Ultra integration. DONE (2026-10-01).** Removed
      `src/utils/jupiter-ultra.ts`, `src/app/api/jupiter/ultra/order/route.ts` and
      `src/app/api/jupiter/ultra/execute/route.ts`. Verified first that they referenced **only each other** —
      a closed island, nothing in `src/` imported them — so the deletion is behaviour-free.
- [ ] **T16 — reclaim still rides the deprecated Ultra host (new, found while doing T1).**
      `jupiter-reclaim.ts:11` sets `JUPITER_RECLAIM_CRAFT_BASE` from `JUPITER_ULTRA_API_BASE`, defaulting to
      `https://ultra-api.jup.ag`, and posts `/reclaim/craft`. Ultra is officially deprecated in favour of Swap
      V2, so **the close-empty-ATAs path depends on a host the venue is retiring**. Unlike the module deleted
      in T1, this one *works* — it is not the POST-to-a-GET-route bug. Worth confirming the sanctioned reclaim
      endpoint before that host is switched off, which is exactly what the T1 audit surfaced by accident.
- [x] **T2 — one env var was wrongly called dead. CORRECTED (verified 2026-10-01).**
      `JUPITER_ULTRA_CLIENT_PLATFORM` was never declared anywhere — it existed only as an inline fallback
      inside the deleted `jupiter-ultra.ts`, so it is gone with it. **`JUPITER_ULTRA_API_BASE` is NOT dead**:
      `src/utils/jupiter-reclaim.ts:11` reads it as the base for `POST /reclaim/craft`. An earlier draft of
      this task claimed "no env cleanup needed" on the grounds that both vars were local to the deleted file;
      that was **wrong**, and the var is kept. See the new T16 — deleting T1 is what surfaced it.
- [x] **T3 — audit every `/order` consumer. DONE (2026-10-01) — and it found a live gap.**
      `/order` is called in exactly one file (`jupiter-swap-quote.ts`), by two consumers.
      `fetchJupiterSwapQuoteDirect` (server) had the full guard chain — 429, `!ok`, 200-with-`errorMessage`
      → `venueRefused`, missing `outAmount`. **`fetchJupiterSwapQuote` (the proxied one) did not**, and that
      is the path a **browser** uses (`direct` is false in a tab) — so a proxied venue refusal read as a
      generic failure, the caller fell back to Lite, and Lite built a transaction the wallet could not pay
      for. That is the T9b defect surviving on the path the UI actually takes. Fixed, with tests covering the
      refusal *and* the not-a-refusal case.
- [x] **T4 — the desk path never compares providers. REJECTED on measurement, 2026-10-01.** The premise was
      right — `collectSwapQuoteCandidates` is sequential and short-circuits, and `pickBestSwapQuote` has only
      ever been handed one candidate. But fanning Raptor and `/order` out in parallel was then measured on
      **40 random mints**: **+5.0 bps mean / 0 median** for **2.59×** the swap time (226 → 585 ms). The
      +1.31 % / −2.41 % spread this task was built on was a **five-pair artifact**, two of them majors.
      **Do not implement this.** The single lane is the lock (§3). If the ranker is ever handed two
      candidates, it should be because a measurement justified it — not because the plumbing allowed it.
- [x] **T17 — the hop ceiling needed a retry, not just a per-pair value. DONE (2026-10-01).**
      T5 resolved the ceiling **per pair**, but from the verified-mint assumption: *"a route touching
      SOL/USDC/USDT has a direct pool"*. Measured on the **buy** direction — 40 real mints, SOL→token —
      **8 had no direct SOL pool** and answered `500 "No direct route found and maxHops=1"`, while **all 8
      quoted at 2**. That is ~20% of buys, and each one escalated to the **keyed Jupiter picker**, spending
      the 0.5 rps execution budget on a display quote — the same cascade T5 removed for token→token, on the
      direction nobody tested. The assumption is **direction-dependent**, so no larger constant fixes it:
      `escalateRaptorHops` steps the ceiling up **once** on a no-route answer (`withNoRouteRetry`, applied at
      both Raptor fetch sites — `/quote` and `/quote-and-swap`), which is free on this lane.
- [x] **T5 — bound Raptor's hops per pair. DONE (d5d214a).** Confirmed live: `RAPTOR_MAX_HOPS=1` makes a
      token→token quote fail outright — `500 "Failed to get quote: No direct route found and maxHops=1"` —
      while `maxHops=2` and `3` return 200, and a SOL/USDC/USDT route returns 200 at 1. No UI surface passed
      `maxHops`, so every quote took the 1-hop default. `src/utils/raptor-hops.ts` now resolves it per pair
      (`resolveRaptorHops`): `RAPTOR_MAX_HOPS` when either side is a verified quote mint, else
      `RAPTOR_TOKEN_TOKEN_HOPS` (default 3). All three Raptor call sites go through it.
- [x] **T5b — `/order`'s empty transaction is the affordability abort. DONE (§2.12, T9b).** Only `/order`
      simulates. Measured: the wallet held **0.00445 SOL** and asked for 0.4186; `/order` refused
      (`errorMessage: "Insufficient funds"`) while Lite and Raptor both built a transaction for it.
      `JupiterSwapQuoteError.venueRefused` now carries that distinction and `prepareDeskSwap` **rethrows**
      instead of falling through to Lite — so `/order` returning no tx aborts the swap, which is precisely
      the capability the cheap lanes lack.
- [x] **T5c — the fan-out's budget question. MOOT — the fan-out was rejected (T4).** It asked whether one
      extra provider call per swap would push the trade lane over its 0.5 rps gate. With a single lane there
      is no added call. Kept as the record that the budget was checked *before* the design was dropped.
- [x] **T6 — a 429 now reads as a rate limit, not a missing route. DONE (2026-10-01).**
      `settleProvider` swallowed every failure identically, so a throttled lane was indistinguishable from a
      dead pair and the engine answered `No route for this pair right now`. It now classifies each failure
      (`QuoteFailure { provider, rateLimited }`, by 429 status or message) and the engine raises a distinct
      `429 · "Quote providers are rate limited right now — try again shortly"` when **every** failure was a
      throttle. Tests pin both directions: a 429 is a rate limit, an `ECONNRESET` is not.
- [ ] **T7 — ship the harness.** Add `scripts/bench-swap-providers.mjs` + `npm run bench:swap-providers`:
      the read-only per-lane harness used here (isolated passes, `--only`, `--json`, tx dump for
      decode). No signing, no broadcast. Re-runnable so a future router change is measured, not assumed.
- [x] **T9 — transfer-fee awareness. DONE (§2.12).** `token-transfer-fee.ts` reads the mint's
      `transferFeeConfig` and `prepareSwapTransaction` raises slippage to fee + margin, so a 100 bps fee
      can no longer eat a 20 bps auto budget and leave the router's post-check failing with `6001`.
- [x] **T9b — a venue refusal must abort, not fall back. DONE (§2.12).** `venueRefused` distinguishes
      `/order`'s 200-with-empty-tx from a transport fault, and `prepareDeskSwap` rethrows it instead of
      letting Lite build a transaction that can never land.
- [x] **T10 — the send path always carries a priority fee now. DONE (2026-10-01).**
      An omitted fee reached the builder as `0` — **no tip** — which is why the first live attempt broadcast
      and never landed. `resolveSwapPriorityFee` (`priority-fee.ts`) resolves it at the single prepare
      boundary, the same place the transfer-fee floor is applied, so `/order`, the Lite fallback and the
      Raptor path all inherit it. Omitted or `0` → **auto-high**, which is a 0.003 SOL *cap* rather than a
      flat charge (the builder pays the venue's estimate, never more); an explicit number → that exact tip,
      clamped; `SWAP_PRIORITY_FEE_LAMPORTS` → an env-tunable exact tip used **only** when the caller passed
      nothing, so it can never override an intentional fee. The concrete instance of the bug
      (`executors.ts`'s `priorityFee || 0`) and `buildSwapTransaction`'s misleading `= 0` default are gone.
- [x] **T11 — the keyless backoff is a cliff, not a slope. STANDING RULE — no code pending.** A burst is
      absorbed, then the IP is locked out for ~120 s and even a trickle is refused; no retry or fan-out may
      hammer through that window, and a Lite 429 must never be read as "no route exists". Both hold by
      construction in the shipped design (Lite is display-only, no fan-out — §3).
- [x] **T12 — measured, 2026-10-01 (prod, 15 DEW round trip).** Confirmed as the dominant phase, so the
      standing rule holds: report **confirm** alongside prepare. Leg 1 — quote 44.6 / build 24.5 / sign 26.3
      / send 52.9 / **confirm→finalized 5,044** / total **5,268 ms**; leg 2 — 25.9 / 15.5 / 6.2 / 28.5 /
      **1,692** / **1,801 ms**. Prepare is **1–10 %**, confirm **96–99 %**. Any future latency work that
      quotes only prepare is optimising the wrong 2 %.
- [x] **T13 — audited 2026-10-01. Zero live callers; Raptor is KEPT by decision.**
      `sendRaptorTransaction` (`solanatracker-raptor.ts:364`) is **never called** — its only reference is its
      own definition. `sendRaptorTransactionDirect` (`:284`) is called from exactly one place,
      `/api/solanatracker/send/route.ts:19`, reachable only *through* that wrapper. Prod sends Raptor-built
      txs over our own RPC (§2.10), so **the phantom-send finding cannot affect prod today**.
      **The removal this task originally proposed was considered and rejected — Raptor's send path stays**
      (§3, locked 2026-10-01): it is the submit half of a stack we are deliberately keeping, and deleting it
      would mean re-adding it before Raptor execution could ever be switched on. The lock is on the code
      staying — **not** on trusting its response: whoever wires it must verify against the chain, because
      `POST /send-transaction` returned `200` **plus a signature** for transactions that never landed.
      The audit's other finding was **documentation drift**: `SWAP_AND_CLOSE_FLOW.md` and
      `whole_process.md` named `/send-transaction` as *the* submit step and cited a `sendRaptorTransaction`
      caller that does not exist — both corrected.
- [x] **T14 — prefer the lane that can also land the swap. SATISFIED by construction.** Jupiter `/order` →
      `/execute` measured ~888 ms end to end against 1,732–5,084 ms for a Lite tx sent over our own RPC. The
      shipped design is `/order`-only for execution with Lite display-only (§3, §2.10), so Lite is never a
      submit lane and there is nothing left to bias — the decision absorbed this task.
- [x] **T15 — the keyless bucket is a ban, not a throttle. STANDING RULE — no code pending.** Lite stayed
      429 for >10 min after a sustained burst, through a 150 s cooldown, at 1 rps, while another IP was fine.
      No retry, fan-out or "fallback" logic may assume the bucket refills on a short timer. The shipped design
      already complies by construction: Lite is display-only (§3) and there is no fan-out to hammer it.
- [x] **T8 — index hygiene. DONE (2026-10-01).** This SPEC and `13-swap-providers.html` are indexed in
      `docs/specs/README.md` and `docs/diagrams/README.md`, and the diagram page is linked from
      `docs/index.html`.

## 5. Env

| Var | Status | Note |
|---|---|---|
| `JUPITER_API_KEY` | keep | primary lane; `api.jup.ag` returns 401 without it |
| `JUPITER_SWAP_ORDER_BASE` / `JUPITER_SWAP_EXECUTE_URL` | keep | already overridable |
| `JUPITER_LITE_SWAP_BASE` | keep | **keyless and per-IP limited — a key cannot raise it** (bogus key returns 200) |
| `RAPTOR_API_BASE` / `RAPTOR_MAX_HOPS` / `RAPTOR_TOKEN_TOKEN_HOPS` | keep | Raptor is keyless. Hops are resolved **per pair** (`raptor-hops.ts`, T5) — `RAPTOR_MAX_HOPS` is the verified-mint ceiling only, never a global one |
| `SWAP_TRANSFER_FEE_MARGIN_BPS` | **added** | headroom above a Token-2022 transfer fee so the fee cannot consume the whole slippage budget (§2.12). Default 30 |
| `SWAP_TRANSFER_FEE_CACHE_MS` | **added** | how long a mint's fee schedule is cached. Default 600000 (10 min) |
| `SWAP_PRIORITY_FEE_LAMPORTS` | **added (T10)** | exact priority-fee tip used when a caller passes **no** fee. Unset (default) → auto-high, a 0.003 SOL cap. A caller-supplied fee always wins |
| `JUPITER_ULTRA_API_BASE` | **keep** | **still read** by `src/utils/jupiter-reclaim.ts:11` as the base for `POST /reclaim/craft` on `ultra-api.jup.ag`. An earlier draft listed this as removable; it is not (T2/T16) |
| `JUPITER_ULTRA_CLIENT_PLATFORM` | **remove** | never declared anywhere — only an inline fallback inside the deleted `jupiter-ultra.ts` |
| DFlow / Titan keys | **do not add** | both rejected (§2.6) |

## 6. Non-goals

- Benchmarking signing, `/execute`, broadcast or landing latency — that needs a real signed
  transaction, so it stays out of a read-only harness.
- Adopting DFlow, Titan or the Rust superagg library.
- Putting swap.io on the execution path.
- Changing the rate gate, priority fees or slippage defaults.

## 7. Risks

- **Cross-provider price comparison is only valid same-moment.** Quotes drift; every price number in
  §2.3 comes from sources fired in parallel, never from sequential passes.
- **Raptor's quote carries our 25 bps fee on top**, and Jupiter's `/order` figure is a simulated
  executed-price estimate — so the columns are not fee-identical. §2.3 therefore also reports the
  taker-less Jupiter quote, which is the like-for-like counterpart; it measured identical, which
  removes the fee as an explanation for the gap.
- **Single-IP observation.** The keyless per-IP ceilings are a property of the VPS egress. Latency and
  price are not IP-sensitive; 429 counts are.
- **Lite's speed is unquota'd.** 5–6× faster, but no key can raise its ceiling, so it stays off the
  critical path (T4/T6).

## 8. Verification

1. `npm run lint && npm run build` clean after T1 (deletion is the only behavioural change).
2. `grep -rn "jupiter-ultra\|jupiter/ultra" src/` returns **nothing** — the import graph is what matters.
   Note `grep -rn "JUPITER_ULTRA" src/` still matches `jupiter-reclaim.ts` (`JUPITER_ULTRA_API_BASE`), which
   is **correct and expected** — that var is live (T2/T16). An earlier draft of this criterion demanded zero
   matches; that was wrong and would have "passed" by deleting a var a live module needs.
3. `npm run bench:swap-providers` reproduces the §2.1 shape: the Lite two-call lane fastest and
   returning a tx on every pair; Jupiter `/order` ~200 ms; all dumped txs decode with `feePayer = taker`.
4. A live swap through the unchanged primary path still confirms.
