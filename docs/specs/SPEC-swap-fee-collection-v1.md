# SPEC — Collecting the swap platform fee v1

**Status:** To-spec (docs only) — **nothing implemented**. Findings from a full investigation of the fee
paths, 2026-10-02. One route is proven end to end; the collected-fee-for-a-real-user question is still open.
**Date:** 2026-10-02
**Surface:** `src/utils/buybulk-fee.ts`, `src/utils/jupiter.ts` (`prepareJupiterSwapPrepared`), `src/utils/swap-executor.ts`, `src/utils/solanatracker-raptor.ts`
**Lane:** Solana trade paths only
**Provenance:** live probes against `api.jup.ag/swap/v2` and the prod RPC, executed inside `reloadsol-web`; every number below is measured, not inferred, unless marked otherwise

---

## 1. Goal

Charge the **0.25 % (25 bps)** platform fee on the lane that actually executes, without giving up landing,
and without needing a Jupiter-side registration.

## 2. What is true today

| mechanism | where it is wired | amount | status |
|---|---|---|---|
| **CLOSE fee** | `createFeeTransferInstructions` → `buildCloseFeeInstructions` (`jupiter.ts:1447`), spliced at `jupiter.ts:1642` | **0.001 SOL fixed** per close | ✅ **proven on chain** |
| **swap fee — Raptor** | `solanatracker-raptor.ts:191-192` consumes `feeAccount` / `feeBps` | 25 bps | ⚠️ **wired, never verified** |
| **swap fee — Jupiter** | **not wired at all** | — | ❌ **never charged** |

**Close fee, proven.** Tx `4C9UMa3wF1i5dTJeWCVuRgnwHk1gjnd352zotoarNimKHztYyGUZrNf9Qbb98nincNJiB7ASZa2Z2WP3GqhLW1u4`,
`err=null`, 2026-10-02 06:56:22:

```
ix 3: System transfer  EQxznKkQ… -> 3V3N5xh6… (dev wallet)
lamports:  +1,000,000  dev wallet
           +433,840    EQxznKkQ…
         -1,513,840    HjzHSCp…   (a token account being closed)
```

`+1,000,000` lamports = exactly `FEE_CONFIG.FEES.CLOSE = 0.001` (`jupiter.ts:215`). A transfer spliced
into a transaction the app builds and lands itself works and the money arrives.

**Jupiter swap fee, never charged.** `prepareJupiterSwapPrepared` (`swap-executor.ts:215-226`) forwards
exactly seven fields — `userPublicKey, inputMint, outputMint, amount, slippageBps, priorityFeeLamports,
direct` — and **neither** `feeAccount` nor `feeBps`. `platformFeeBps` occurs nowhere in the repo.

**Raptor swap fee, unverified.** The params reach the Raptor build, but the fee account
(`BUYBULK_SOL_FEE_ACCOUNT = 3V3N5xh6…`) is the same address as the trading wallet, so the transfer is
self-directed and invisible on chain. **This is the blind spot that hid the whole problem.**

## 3. Root cause — the fee account must be a token account

Every failed attempt in this investigation traces to one argument. `BUYBULK_SOL_FEE_ACCOUNT` is the dev
**wallet**. Raptor accepts a wallet; **Jupiter requires a token account for the feeMint.**

Controlled A/B on the identical `/build` response, only `feeAccount` varied:

| feeAccount | simulation | detail |
|---|---|---|
| *(fee params off)* | **PASSED** | 95,209 CU, route completes |
| dev **wallet** | **FAILED** | `{"InstructionError":[5,{"Custom":6025}]}` at **1,119 CU** |
| dev **WSOL ATA** | **PASSED** | 96,862 CU — **+1,653 CU**, the fee collection |

`0x1789` = 6025, thrown by `JUP6LkbZbjS1…` at `Instruction: RouteV2` before any routing. Slippage was
ruled out (run at 1000 bps); the packet limit was ruled out (588 bytes of headroom); the blockhash was
ruled out (a fresh one was used, and the failure reproduces at 1,119 CU).

**This is the same requirement as the documented `referralTokenAccount`,** which is why the referral route
also silently dropped.

## 4. The feeMint rule — six measurements

`feeMint` is the **highest-priority mint in the pair** (SOL > stables > LSTs > bluechips > others), *not*
the output mint:

| pair | feeMint | referral applied? |
|---|---|---|
| `SOL→DEW` · `DEW→SOL` · `SOL→USDC` | **SOL** | ✅ applied |
| `DEW→USDC` · `USDC→DEW` | **USDC** | ❌ dropped |
| `DEW→BPX` | **BPX** | ❌ dropped |

**Coverage:** a **SOL** token account covers every buy and sell; a **USDC** account covers stable pairs.
Memecoin→memecoin cannot be covered economically — those earn nothing, **and they drop silently**
(`feeBps` falls back to 10, `referralAccount` absent, HTTP 200).

## 5. Options — every route, settled

| route | verdict | measured evidence |
|---|---|---|
| `/order` + `platformFeeBps` | ❌ **silent no-op** | 200 OK, our fee ignored, `feeBps=10` |
| `/order` + `referralFee: 25` | ❌ **impossible** | 400 *"The referralFee parameter must be between 50 and 255 (inclusive)"* |
| `/order` + `referralFee: 50` | ✅ works, **3 caveats** | `feeBps=50`, `ref=APPLIED`. Needs a registered account (`REFER4Zg…` under project `DkiqsTrw1…`), Jupiter keeps **20 %** → 40 net, and it drops without a token account per feeMint |
| splice our transfer → `/execute` | ❌ **dead** | spliced: `400 {"code":-1002,"error":"Invalid transaction received"}`; unmodified control: 200 Success, **finalized** |
| splice + self-land an `/order` tx | ❌ **never landed**, 3 attempts | accepted, never confirmed |
| **`/build` + `platformFeeBps` + WSOL ATA** | ✅ **simulates clean AND lands** | e2e `62pRpC9FRXJe7ybkYUeAJwdPZ5AKQZEwsQxnrHcU3QnwnUtn1zo8pD6N4KHcRJw96GDhjVLbbX7iENybZ2D2YAPU`, `err=null`, CU 111,320 |

`/build` accepts `platformFeeBps: 25` — **where `/order` silently ignores it**. `/build` returns raw
instructions, so the app assembles and lands the transaction itself: the same shape the **close fee** has
always used successfully.

## 6. Recommended design

1. **Use `/build`** for the fee-bearing path (accepting that we land it).
2. **`feeAccount` = the feeMint's ATA** — derive it per mint (WSOL ATA for SOL, USDC ATA for USDC).
   **Prerequisite:** the ATA must exist. The fee silently does not happen without it, and the last run
   **closed** the dev WSOL ATA.
3. **Set the tip by replacing** Jupiter's `SetComputeUnitPrice`, never appending — a second one is
   `invalid transaction: Transaction contains a duplicate instruction`.
4. **Land it ourselves** — the tx simulates clean, which every earlier attempt failed at.
5. **Guard**: assert the response's `feeBps` and the on-chain CU delta, so the fee can never silently stop.

### Env

| key | default | meaning |
|---|---|---|
| `BUYBULK_PLATFORM_FEE_BPS` | `25` | unchanged; `resolveBuybulkFeeBps` ignores callers |
| `BUYBULK_SOL_FEE_ACCOUNT` | dev wallet | **still the right party, still the wrong type** — the ATA is derived from it |

## 7. Non-goals

- **Not** raising the fee to 50 bps to fit `referralFee`.
- **Not** adopting `@jup-ag/referral-sdk`.
- **Not** changing the Raptor lane, which already passes 25 bps.
- **Not** touching the RH/0x path.

## 8. Risks

- **Landing is now ours.** `/execute` handles send + confirm + priority fee; `/build` does not. Measured:
  `/execute`'s own tip was 839–3,252 µlamports/CU depending on the quote — far below the 12,000–80,000
  lamports the app's own landings pay.
- **WSOL may not be a durable fee mint.** SWOL accounts are unwrapped and closed at cleanup — observed:
  the fee ATA's lamports fell **1,488,440** and the account disappeared. **Collecting in USDC sidesteps this.**
- **A missing ATA = a silent zero.** No error, HTTP 200, `feeBps` back to 10.

## 9. Open items

1. **Prove the fee collects for a taker that isn't us.** Blocked on wallet balance (dev wallet had
   **0.0178 SOL**); needs ~0.05 SOL and two transactions.
2. **Raptor's 25 bps is still unverified** on chain.
3. **A tip replacement did not take effect** — the landed tx paid **366,800** lamports despite a
   300,000 µlamports/CU replacement. Unexplained.
4. Whether to standardise on **USDC** as the fee mint.

## 10. Retractions recorded in this investigation

- **"Self-landing failed because the tip was too low"** — **retracted.** The landed `/build` tx paid
  ~3,250 µlamports/CU, the same order as the `/order` txs that never landed.
- **"The sim understates the priority fee 100×"** — **wrong direction.** `SIM_PRIORITY_FEE_QUOTE = 0.00003`
  matches the code's own constant; the measured median across 19 txs is **20,000** lamports.
- **"The fee account collects nothing"** — **overstated.** The dev wallet is the treasury by design
  (`docs/whole_process.md:95`); it is self-directed only for our own trades.

## 11. Verification gate

1. **Simulate before every attempt** (`simulateTransaction` with full logs) — 6025 took three runs to
   name because the error print was truncated to 400 characters.
2. Assert the **fee ATA exists** before building; fail loudly, never silently.
3. A/B the `feeAccount` — the wallet must fail, the ATA must pass. This is the regression test for §3.
4. Confirm the on-chain CU delta matches a fee collection, not just `err=null`.
