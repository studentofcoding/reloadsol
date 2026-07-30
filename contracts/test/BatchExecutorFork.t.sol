// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Fork smoke test for Robinhood Chain (chainId 4663).
/// Run with: forge test --fork-url https://rpc.arrowrpc.com -vv
/// Without a fork the test self-skips (chainid guard), so plain `forge test`
/// stays offline-friendly.

interface Vm {
    function envOr(string calldata name, string calldata defaultValue)
        external
        view
        returns (string memory);
}

contract BatchExecutorForkTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Canonical addresses (see contracts/README.md, src/utils/dlmm/rh-clmm/config.ts).
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function assertTrue(bool cond, string memory what) internal pure {
        require(cond, string.concat("assertTrue failed: ", what));
    }

    /// Verifies canonical Permit2 + WETH are deployed on chain 4663.
    function test_canonicalContractsDeployedOn4663() public {
        // Skip gracefully when not running against the 4663 fork.
        if (block.chainid != 4663) {
            emit log("SKIP: not on chain 4663 (run with --fork-url)");
            return;
        }
        // Optional belt-and-braces env guard: set FORK_SMOKE=0 to force-skip.
        if (keccak256(bytes(vm.envOr("FORK_SMOKE", "1"))) == keccak256("0")) {
            emit log("SKIP: FORK_SMOKE=0");
            return;
        }

        assertTrue(PERMIT2.code.length > 0, "canonical Permit2 has no code on 4663");
        assertTrue(WETH.code.length > 0, "WETH has no code on 4663");
    }

    event log(string);
}
