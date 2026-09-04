# contracts/ — BatchExecutor (REL-6)

Owner-scoped, pull-based, atomic batch executor for **Robinhood Chain (chainId 4663)**.
One wallet signature executes: WETH wrap + Permit2 token pulls + per-leg router
approvals + N Kyber swaps, removing any dependence on EIP-5792 `wallet_sendCalls`.

## Layout

```
foundry.toml            self-contained (no git submodules / external libs)
src/BatchExecutor.sol   the executor (immutable, no proxy)
test/BatchExecutor.t.sol  unit tests with mocks (no fork needed)
script/Deploy.s.sol     deploy script (env-driven, no hardcoded keys)
```

The project is deliberately dependency-free: tests/scripts declare their own
minimal `Vm` cheatcode interface instead of importing `forge-std`, so
`forge build` / `forge test` work offline after installing Foundry.

## Design

- `executeBatch(Call[])` — any trader (`msg.sender`); owner only
  `setPaused` / `transferOwnership` / rescue sweeps. Permit2 pulls inside a
  batch come from the **payer** (the batch caller), not the owner. Plain `call`
  only (never `delegatecall`), **atomic by default**. Leftover native ETH is
  swept back to the caller at the end.
- Pull-based token sourcing (REL-7): the wallet approves each token **once** to
  canonical Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` (ERC20) and
  grants the executor a Permit2 allowance. Inside the batch,
  `pullAndApproveRouter(token, router, pullAmount, approveAmount, expiration)`:
  1. `permit2.transferFrom(wallet → executor, pullAmount, token)`
  2. reset-then-set ERC20 `approve(router, approveAmount)` (what Kyber's
     MetaAggregationRouter actually consumes)
  3. `permit2.approve(token, router, …)` for Permit2-aware spenders
- WETH wrap: batch can call `WETH.deposit{value}` directly as a step (or
  `wrapETH` / `wrapAllETH` / `unwrapWETH` helpers), so a single signature can
  wrap ETH → batch-buy N tokens.
- `sweepToken` / `sweepETH` rescue dust (callable while paused).
- Reentrancy-guarded batch entrypoint, `setPaused` stops `executeBatch` only.
- No upgradeability: deploy a new contract to change behavior.

## Toolchain

No Solidity toolchain is vendored here. Install Foundry (user-level):
https://getfoundry.sh — then:

```bash
cd contracts
forge build
forge test -vv
```

## Deploy (chain 4663) — NOT run from this repo yet

```bash
cd contracts
export RPC_URL_4663="https://<rh-rpc>"
export DEPLOYER_KEY="0x<64-hex-private-key>"   # env only, never in files
# optional overrides: PERMIT2_ADDRESS, WETH_ADDRESS
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL_4663" --broadcast
```

Owner is the deployer (pause / rescue). Traders buy with their own Rabby;
`DEPLOYER_KEY` is not the public address (`0x` + 40 hex).

## Verify (Blockscout)

Robinhood Chain explorer is Blockscout (`https://robinhoodchain.blockscout.com`):

```bash
forge verify-contract <DEPLOYED_ADDRESS> src/BatchExecutor.sol:BatchExecutor \
  --chain-id 4663 \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
      0x000000000022D473030F116dDEE9F6B43aC78BA3 \
      0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 \
      <OWNER_ADDRESS>)
```

## After deploy

Set the app env var so the TS execution layer picks up executor mode
(see `src/utils/dlmm/rh-batch-executor.ts`):

```
NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS=0x<deployed>   # or RH_BATCH_EXECUTOR_ADDRESS
```

Empty/unset = executor mode disabled; behavior falls back to 5792 → sequential.
