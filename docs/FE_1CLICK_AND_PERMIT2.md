# Robinhood parent one-click trades and Permit2

## Status

| Ticket | Status | Implementation |
|---|---|---|
| B1 readiness | Done | `rh-permit2-readiness.ts` reads ERC20→Permit2 and Permit2→spender allowances per token and reports `ready`, `needs-erc20`, `needs-permit2`, or `expired`. |
| B2 setup planner | Done | Setup-only calls approve canonical Permit2 for `maxUint256` and the supplied spender for `maxUint160`/`maxUint48`; duplicate token approvals are removed. |
| B3 setup sheet | Done | The sheet explains the permission, lists token readiness, and submits setup through `executeRhWalletCalls`. It never includes a swap. |
| B4 trade surfaces | Done | Bulk buy, bulk sell, Fast Swap, and RH Swap gate parent-wallet BatchExecutor submission on live readiness. |
| A10 caps | Done | RH and Solana caps are separate constants. RH remains capped at 5; current Solana behavior remains 5. |
| A8 mint reuse | Done | The planner accepts any spender, including POSM. Swap setup grants the shared max ERC20→Permit2 allowance, so the existing v4 mint planner skips that ERC20 approval and only checks its POSM Permit2 allowance. Mint execution is not packed into BatchExecutor. |

## User flow

1. Connect the Robinhood parent wallet once; changing screens does not disconnect it.
2. For an ERC20 input token, the banner checks both allowance layers.
3. If setup is needed, open **Set up** and choose **Approve once**.
4. Setup may contain:
   - `ERC20.approve(Permit2, maxUint256)`
   - `Permit2.approve(token, BatchExecutor, maxUint160, maxUint48)`
5. Return to the trade confirmation. With live allowances, the wallet call list has
   no approval prefix and contains only `BatchExecutor.executeBatch`.
6. The user confirms each trade. BatchExecutor atomically performs all pulls and
   swaps, up to the RH cap of five tokens.

Native ETH needs no Permit2 setup. WETH, USDG, and sell input tokens do. Readiness is
scoped to the connected account, input token, and configured spender, so switching
wallets or changing the BatchExecutor address triggers a separate check.

If BatchExecutor is not configured, the UI explicitly describes the legacy path.
The sequential-sign hint is only shown in that mode. Bound-GMGN and Solana signing
behavior are unchanged.

## Verification checklist

- [x] Readiness statuses and allowance fields covered by mocked read tests.
- [x] Planner emits both max approvals when required.
- [x] Planner deduplicates repeated input tokens.
- [x] Planner emits an empty approval list for live allowances.
- [x] Existing Kyber and BatchExecutor unit tests remain green.
- [x] Parent buy/sell and both fast/single swap entry points are gated.
- [x] No changes to bound-GMGN server signing.
- [x] No changes to Solana transaction signing.
