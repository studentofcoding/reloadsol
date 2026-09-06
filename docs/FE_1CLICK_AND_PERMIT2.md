# FE 1-click + Permit2 setup tickets

Goal: wallet stays connected; after a one-time allowance setup, RH parent bulk buy/sell and fast DLMM swaps are **one wallet confirm** (BatchExecutor `executeBatch`), not N approves + N swaps.

Caps today: `MAX_TRADE_TOKENS = 5` in `src/utils/trade-ui-limits.ts` (matches BatchExecutor / Kyber UX). Solana bulk (~20) is a separate path (Raptor/Jupiter + wallet sign each batch).

---

## A. File-level FE checklist

### A0. Env / mode (do first)

| Check | Where | Done when |
| --- | --- | --- |
| `NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS` set to deployed 4663 executor | `.env*` / Vercel / host | `getRhBatchExecutorAddress()` non-null in browser |
| Optional `NEXT_PUBLIC_RH_PERMIT2_SWAPS=1` | same | only needed for **non-executor** Permit2→Kyber router; executor implies Permit2→executor |
| Confirm broadcast address matches env | `contracts/broadcast/Deploy.s.sol/4663/run-latest.json` | address string equal |
| Parent (Rabby) vs bound GMGN | `BulkTokenBuyer` / `useRhParentPath` | Parent uses Kyber+executor; bound stays GMGN server-sign |

### A1. `src/utils/dlmm/rh-batch-executor.ts`

- [ ] Keep executor as single source of truth for fee label (`RH_PLATFORM_FEE_LABEL`), encode helpers, `planExecutorBatch`.
- [ ] Export a small **read-only readiness helper** (new): given `publicClient`, `account`, `token`, `spender=executor`, return `{ erc20ToPermit2Ok, permit2ToSpenderOk, expiresAt }`.
- [ ] Do not change `MAX` pull math (`platformFeeCover`) without FE copy update.

### A2. `src/utils/dlmm/rh-kyber-swap.ts`

- [ ] Buy: `executeRhParentKyberBuy` — when executor set, path must stay: prepare legs → `executorWalletCalls` (deduped Permit2 prefix + one `executeBatch`) → `executeRhWalletCalls`.
- [ ] Sell: `executeRhParentKyberSell` — same executor branch.
- [ ] **Gap:** first trade after fresh wallet still may emit 1–2 approval txs *before* `executeBatch`. That is correct until setup-once lands; after setup, prefix should be empty → true 1-sign.
- [ ] Add / use readiness helper so callers can skip dry-run signing when allowances already max.
- [ ] Keep legacy + `RH_PERMIT2_SWAPS` fallback; never break when executor env unset.
- [ ] Tests: `rh-kyber-swap.test.ts` + `rh-batch-executor.test.ts` cover empty-prefix when allowances live.

### A3. `src/utils/dlmm/rh-send-calls.ts`

- [ ] Prefer EIP-5792 `wallet_sendCalls` when available; sequential fallback must still attribute leg failures (`RhSequentialWriteError`).
- [ ] With executor + warm Permit2, call list length should be **1**; assert in UI toast (“1 signature”).

### A4. `src/components/BulkTokenBuyer.tsx`

- [ ] RH parent submit already calls `executeRhParentKyberBuy` (~L856). Keep that as only parent path.
- [ ] Cap enforcement via `MAX_TRADE_TOKENS` (~L616/1082/2297) — keep **5** on RH; do **not** silently raise for Sol without separate UX.
- [ ] **Add:** pre-submit banner when `useRhParentPath && getRhBatchExecutorAddress()`:
  - Ready: “1-click bulk (executor) · 0.25% fee”
  - Needs setup: “Approve once (WETH/USDG → Permit2 → BatchExecutor), then 1-click”
- [ ] Wire **Setup once** button → shared `RhPermit2Setup` (ticket B).
- [ ] Sequential hint today (~L1733) when executor missing — keep; hide when executor present.
- [ ] Bound/GMGN path unchanged (`executeGmgnBulkBuy`).

### A5. `src/components/BulkTokenSeller.tsx`

- [ ] Mirror buyer: `executeRhParentKyberSell` (~L942), fee label (~L2157/2904), setup banner + button.
- [ ] For sells, readiness is **per selected token** (token → Permit2 → executor). Show “N/M tokens ready”.
- [ ] Cap still 5; selling more requires second batch (explicit UX, not silent).

### A6. `src/components/dlmm/DlmmFastSwapModal.tsx`

- [ ] Parent+executor already skips confirm modal and runs (~L281) — good 1-click pattern; keep.
- [ ] Still can hit cold Permit2 on first swap of a quote token — run readiness check before `runConfirmed`; if not ready, open setup sheet instead of surprise multi-sign.
- [ ] Fee line (~L582) stays when executor set.

### A7. `src/components/RhGmgnSwapPanel.tsx`

- [ ] Same readiness gate before parent Kyber buy/sell (~L541/616).
- [ ] `sequentialSignHint` (~L778) only when executor **absent**.
- [ ] Fee copy (~L942/1038) consistent with buyer/seller.

### A8. DLMM / CLMM mint (parallel pattern, not BatchExecutor yet)

- [ ] `src/utils/dlmm/rh-clmm/v4.ts` `planPermit2Calls` — POSM spender; reuse **same ERC20→Permit2** one-time approve as swaps (token→Permit2 is shared).
- [ ] Ticket: after swap setup, mint should only need Permit2→POSM if missing (not another ERC20 approve).
- [ ] Optional later: pack mint settle into executor-style batch if product wants LP 1-click same as swaps.

### A9. Solana (out of RH executor scope)

- [ ] `executeBulkBuy` / Raptor path in buyer — still **wallet signs** the batch (~20 tokens). Document in UI: “Solana: one sign per batch; not Permit2.”
- [ ] Do not pretend FE alone gives zero-sign; server key / delegated auth is a separate epic.

### A10. Shared UI / limits

- [ ] `src/utils/trade-ui-limits.ts` — consider `MAX_TRADE_TOKENS_RH = 5` and `MAX_TRADE_TOKENS_SOL = 20` (or keep one constant with chain-aware helper) so messaging matches reality.
- [ ] `WalletConnectGate` — ensure chain 4663 + Rabby before setup CTA.

---

## B. Permit2 “setup once” tickets

### B1. Shared module — `src/utils/dlmm/rh-permit2-readiness.ts` (new)

**Acceptance**

1. `readPermit2Readiness({ publicClient, account, tokens, spender })` returns per-token:
   - `erc20Allowance` vs Permit2
   - `permit2Allowance` + `expiration` vs spender (BatchExecutor or POSM)
   - `status: 'ready' | 'needs-erc20' | 'needs-permit2' | 'expired'`
2. Uses existing `PERMIT2`, `permit2Abi`, `PERMIT2_MAX_UINT160/48` from batch-executor / config.
3. Pure reads; no writes. Unit-tested with mocked `readContract`.

### B2. Shared planner — extend `planPermit2`-style for executor spender

**Acceptance**

1. Reuse v4 `planPermit2Calls` pattern but `spender = getRhBatchExecutorAddress()`.
2. Deduplicate ERC20→Permit2 across tokens (one approve if any token needs it).
3. Emit max allowances (`maxUint256` ERC20; max160/max48 Permit2) so setup is truly once.
4. Feed into `executeRhWalletCalls` as **setup-only** call list (no `executeBatch`).

### B3. UI — `src/components/rh/RhPermit2SetupSheet.tsx` (new)

**Flow**

1. Open from Bulk buy/sell, FastSwap, RhGmgn when readiness ≠ all ready.
2. List tokens (quote asset + selected sell tokens): Ready / Needs approval.
3. Primary CTA: **Approve once** → send planned calls (5792 batch if possible).
4. On success, re-read readiness → show Ready → primary trade button enables 1-click.
5. Copy: “This does not move funds. It lets BatchExecutor pull for future bulk trades. You still confirm each trade.”

**Acceptance**

- Cold wallet: setup = 1–2 signatures; next bulk buy with ≤5 tokens = **exactly 1** signature (`executeBatch` only).
- Warm wallet: setup CTA hidden; trade stays 1-sign.
- Executor unset: sheet explains sequential/legacy; no false 1-click promise.

### B4. Wire into surfaces

| Surface | Hook |
| --- | --- |
| `BulkTokenBuyer` | Before `handleBulkBuy` / confirm; banner + sheet for WETH/USDG/ETH path token |
| `BulkTokenSeller` | Before sell; per selected mint |
| `DlmmFastSwapModal` | Replace blind skip-confirm when not ready → setup then trade |
| `RhGmgnSwapPanel` | Same as fast swap |

### B5. Analytics / ops

- [ ] Track `permit2_setup_started|succeeded|failed` and `executor_batch_signed` (call count).
- [ ] Dashboard/help blurb in `docs/01-product-and-trading.md`: setup once → 1-click.

### B6. Out of scope (later epic)

- Meta-tx / relayer so **zero** wallet pop after allowances (funds still in user wallet).
- Solana session keys / server signer for true unattended bulk.
- Packing Uni v4 mint into BatchExecutor.

---

## C. Suggested build order

1. B1 readiness reads + tests  
2. B2 setup planner + B3 sheet  
3. A4–A7 wire banners/gates  
4. A10 chain-aware caps copy  
5. A8 mint shared ERC20→Permit2 reuse  
6. B6 only if product insists on zero pop  

## D. Definition of done (RH parent)

- Executor address live in prod env.  
- Fresh Rabby: Setup once → then Bulk buy 5 tokens → **one** Rabby confirm → all legs land or atomic fail.  
- Second buy same quote token: **one** confirm, no approve txs.  
- Seller same for previously approved mints.  
- Fast swap parent path matches.  
- Bound GMGN + Solana paths unchanged / clearly labeled.
