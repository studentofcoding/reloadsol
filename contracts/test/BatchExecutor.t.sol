// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BatchExecutor, IERC20} from "../src/BatchExecutor.sol";

/// Minimal cheatcode interface — self-contained (no forge-std dependency).
interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes memory revertData) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address who, uint256 amount) external;
}

contract TestBase {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, string.concat("assertEq failed: ", what));
    }

    function assertTrue(bool cond, string memory what) internal pure {
        require(cond, string.concat("assertTrue failed: ", what));
    }
}

// ── Mocks ────────────────────────────────────────────────────────────

contract MockERC20 {
    string public name;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name) {
        name = _name;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "bal");
        require(allowance[from][msg.sender] >= amount, "allow");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("WETH") {}

    receive() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "bal");
        balanceOf[msg.sender] -= wad;
        totalSupply -= wad;
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "send");
    }
}

/// Mirrors canonical Permit2 AllowanceTransfer semantics (subset): pulls from
/// the owner granted to this Permit2 contract (exactly like real Permit2).
contract MockPermit2Pull {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(amount, expiration, 0);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage a = allowance[from][token][msg.sender];
        require(a.amount >= amount, "p2 amount");
        // block.timestamp is safe here: mock-only expiry check mirroring real
        // Permit2 semantics; validator manipulation of a few seconds is irrelevant.
        // forge-lint: disable-next-line(block-timestamp)
        require(a.expiration == 0 || a.expiration >= block.timestamp, "p2 expired");
        a.amount -= amount;
        // Real Permit2 calls token.transferFrom(from, to, amount) using the
        // owner's ERC20 allowance to Permit2.
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "p2 erc20");
    }
}

/// Simulates a Kyber-style router: pulls tokenIn via ERC20 transferFrom from
/// msg.sender and pays out tokenOut 1:1 (minus nothing — pure plumbing test).
contract MockRouter {
    function swapExact(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)
        external
    {
        require(IERC20(tokenIn).transfer(address(2), 0), "noop"); // touch
        (bool ok, bytes memory ret) = tokenIn.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amountIn)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "pull in");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function swapThatReverts() external pure {
        revert("router: insufficient output");
    }
}

// ── Tests ────────────────────────────────────────────────────────────

contract BatchExecutorTest is TestBase {
    address constant OWNER = address(0xA11CE);
    address constant USER2 = address(0xB0B);

    MockWETH weth;
    MockERC20 usdg;
    MockERC20 tokenOut;
    MockPermit2Pull permit2;
    MockRouter router;
    BatchExecutor exec;

    function setUp() public {
        weth = new MockWETH();
        usdg = new MockERC20("USDG");
        tokenOut = new MockERC20("OUT");
        permit2 = new MockPermit2Pull();
        router = new MockRouter();
        exec = new BatchExecutor(address(permit2), address(weth), OWNER);

        // Fund owner with USDG and set up Permit2 path:
        usdg.mint(OWNER, 1_000 ether);
        vm.startPrank(OWNER);
        usdg.approve(address(permit2), type(uint256).max); // one-time ERC20 approve to Permit2
        permit2.approve(address(usdg), address(exec), type(uint160).max, type(uint48).max); // Permit2 allowance to executor
        vm.stopPrank();

        usdg.mint(USER2, 1_000 ether);
        vm.startPrank(USER2);
        usdg.approve(address(permit2), type(uint256).max);
        permit2.approve(address(usdg), address(exec), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _call(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (BatchExecutor.Call memory)
    {
        return BatchExecutor.Call({target: target, value: value, data: data, allowFailure: false});
    }

    // Happy path: pull USDG via Permit2 + approve router + swap, one tx.
    function test_happyPath_pullSwapSweep() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](3);
        calls[0] = _call(
            address(exec),
            0,
            abi.encodeWithSelector(
                BatchExecutor.pullAndApproveRouter.selector,
                address(usdg),
                address(router),
                uint160(100 ether),
                uint256(100 ether),
                uint48(block.timestamp + 1 days)
            )
        );
        calls[1] = _call(
            address(router),
            0,
            abi.encodeWithSelector(
                MockRouter.swapExact.selector, address(usdg), address(tokenOut), 100 ether, 99 ether
            )
        );
        // sweep leftover USDG dust (none here, but proves the call works)
        calls[2] = _call(
            address(exec),
            0,
            abi.encodeWithSelector(BatchExecutor.sweepToken.selector, address(usdg), OWNER)
        );

        vm.prank(OWNER);
        exec.executeBatch(calls);

        assertEq(usdg.balanceOf(OWNER), 900 ether, "owner usdg spent");
        assertEq(tokenOut.balanceOf(address(exec)), 99 ether, "exec received output");
        assertEq(usdg.allowance(address(exec), address(router)), 0, "router allowance consumed by swap");
    }

    // Failure atomicity: second leg reverts → whole tx reverts, first pull undone.
    function test_failureAtomicity() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](2);
        calls[0] = _call(
            address(exec),
            0,
            abi.encodeWithSelector(
                BatchExecutor.pullAndApproveRouter.selector,
                address(usdg),
                address(router),
                uint160(50 ether),
                uint256(50 ether),
                uint48(block.timestamp + 1 days)
            )
        );
        calls[1] = _call(address(router), 0, abi.encodeWithSelector(MockRouter.swapThatReverts.selector));

        vm.prank(OWNER);
        // BatchCallFailed(index=1, inner revert data from the router). The
        // bytes4-selector overload only matches parameterless errors, so
        // match the full encoded error.
        bytes memory inner = abi.encodeWithSignature("Error(string)", "router: insufficient output");
        vm.expectRevert(
            abi.encodeWithSelector(BatchExecutor.BatchCallFailed.selector, uint256(1), inner)
        );
        exec.executeBatch(calls);

        // Atomic: owner's balance and Permit2 allowance unchanged.
        assertEq(usdg.balanceOf(OWNER), 1_000 ether, "no partial pull");
    }

    // allowFailure: failing call is skipped, batch continues.
    function test_allowFailureContinues() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](2);
        calls[0] = BatchExecutor.Call({
            target: address(router),
            value: 0,
            data: abi.encodeWithSelector(MockRouter.swapThatReverts.selector),
            allowFailure: true
        });
        calls[1] = _call(
            address(exec),
            0,
            abi.encodeWithSelector(
                BatchExecutor.pullAndApproveRouter.selector,
                address(usdg),
                address(router),
                uint160(10 ether),
                uint256(10 ether),
                uint48(block.timestamp + 1 days)
            )
        );

        vm.prank(OWNER);
        exec.executeBatch(calls);
        assertEq(usdg.balanceOf(address(exec)), 10 ether, "second call ran");
    }

    // Wrap: fund executeBatch with native ETH, wrap to WETH inside the batch.
    function test_wrapETHInsideBatch() public {
        vm.deal(OWNER, 5 ether);
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](1);
        calls[0] = _call(address(weth), 1 ether, abi.encodeWithSelector(MockWETH.deposit.selector));

        vm.prank(OWNER);
        exec.executeBatch{value: 1 ether}(calls);
        assertEq(weth.balanceOf(address(exec)), 1 ether, "exec weth");
        assertEq(address(exec).balance, 0, "no leftover eth");
        assertEq(OWNER.balance, 4 ether, "1 ether wrapped, none left over to sweep");
    }

    // Trader (non-owner) can executeBatch; pull is from that trader.
    function test_traderExecuteBatchPullsFromPayer() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](2);
        calls[0] = _call(
            address(exec),
            0,
            abi.encodeWithSelector(
                BatchExecutor.pullAndApproveRouter.selector,
                address(usdg),
                address(router),
                uint160(100 ether),
                uint256(100 ether),
                uint48(block.timestamp + 1 days)
            )
        );
        calls[1] = _call(
            address(router),
            0,
            abi.encodeWithSelector(
                MockRouter.swapExact.selector, address(usdg), address(tokenOut), 100 ether, 99 ether
            )
        );

        vm.prank(USER2);
        exec.executeBatch(calls);

        assertEq(usdg.balanceOf(USER2), 900 ether, "trader usdg spent");
        assertEq(usdg.balanceOf(OWNER), 1_000 ether, "owner usdg untouched");
        assertEq(tokenOut.balanceOf(address(exec)), 99 ether, "exec received output");
    }

    // Random caller cannot sweep or pause.
    function test_randomCannotSweepOrPause() public {
        usdg.mint(address(exec), 1 ether);
        vm.startPrank(USER2);
        vm.expectRevert(BatchExecutor.NotOwner.selector);
        exec.sweepToken(address(usdg), USER2);
        vm.expectRevert(BatchExecutor.NotOwner.selector);
        exec.setPaused(true);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(exec)), 1 ether, "dust stays");
        assertTrue(!exec.paused(), "not paused");
    }

    // Pause blocks executeBatch but not sweeps.
    function test_pauseBlocksBatchNotSweep() public {
        // Put dust in the executor first.
        usdg.mint(address(exec), 7 ether);

        vm.startPrank(OWNER);
        exec.setPaused(true);

        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](1);
        calls[0] = _call(address(weth), 0, abi.encodeWithSelector(MockWETH.deposit.selector));
        vm.expectRevert(BatchExecutor.Paused.selector);
        exec.executeBatch(calls);

        // Sweep still works while paused (rescue path).
        exec.sweepToken(address(usdg), OWNER);
        vm.stopPrank();
        assertEq(usdg.balanceOf(OWNER), 1_000 ether + 7 ether, "swept while paused");
    }

    // pullAndApproveRouter is also owner-gated when called directly.
    function test_pullOnlyOwner() public {
        vm.prank(USER2);
        vm.expectRevert(BatchExecutor.NotOwner.selector);
        exec.pullAndApproveRouter(
            address(usdg), address(router), 1, 1, uint48(block.timestamp + 1 days)
        );
    }

    // Empty batch reverts.
    function test_emptyBatchReverts() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](0);
        vm.prank(OWNER);
        vm.expectRevert(BatchExecutor.NoCalls.selector);
        exec.executeBatch(calls);
    }

    // Ownership transfer.
    function test_transferOwnership() public {
        vm.prank(OWNER);
        exec.transferOwnership(USER2);
        assertTrue(exec.owner() == USER2, "owner rotated");
    }
}
