// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BatchExecutor} from "../src/BatchExecutor.sol";

/// Minimal cheatcode interface — self-contained (no forge-std dependency).
interface Vm {
    function envUint(string calldata name) external returns (uint256);
    function envOr(string calldata name, address defaultValue) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @title Deploy BatchExecutor to Robinhood Chain (chainId 4663).
/// @dev Run (never commit keys — env only):
///      RPC_URL_4663=... DEPLOYER_KEY=0x... \
///      forge script script/Deploy.s.sol:Deploy \
///        --rpc-url $RPC_URL_4663 --broadcast --verify
contract Deploy {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Canonical Permit2 (same address on all EVM chains that have it).
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    // Robinhood Chain WETH (src/utils/dlmm/rh-clmm/config.ts `wrapped`).
    address constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external returns (BatchExecutor exec) {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        // Optional override if canonical Permit2 is ever unavailable on 4663.
        address permit2 = vm.envOr("PERMIT2_ADDRESS", PERMIT2);
        address weth = vm.envOr("WETH_ADDRESS", RH_WETH);

        vm.startBroadcast(deployerKey);
        // Owner = the trading hot wallet (deployer). Rotate later via
        // transferOwnership if a 4337 session key takes over.
        exec = new BatchExecutor(permit2, weth, msg.sender);
        vm.stopBroadcast();
    }
}
