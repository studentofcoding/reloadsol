// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BatchExecutor — pull-based atomic batch executor for
///        Robinhood Chain (chainId 4663).
/// @notice Any trader (`msg.sender`) can run wrap + Permit2 pulls + N Kyber
///         swaps as ONE signed transaction. Owner only pauses, transfers
///         ownership, and rescues dust.
///
/// Design notes:
///  - Immutable: no proxy, no upgrade path. Deploy a new contract to change it.
///  - Pull-based token sourcing: the wallet approves each token ONCE to the
///    canonical Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) and gives
///    this contract a Permit2 allowance. `pullAndApproveRouter` then pulls
///    tokens in via `permit2.transferFrom` and sets per-leg allowances for the
///    Kyber router (plain ERC20 approve, which is what Kyber's
///    MetaAggregationRouter consumes, plus a Permit2 approve for
///    Permit2-aware routers).
///  - Plain `call` only — never DELEGATECALL — so this contract's storage and
///    owner context can never be hijacked by a batch target.
///  - Atomic by default: any failing call reverts the whole batch. A per-call
///    `allowFailure` flag exists for non-critical calls (e.g. dust sweeps).
///  - Reentrancy-guarded and pausable (pause stops executeBatch only; sweep /
///    rescue of funds by the owner keeps working).
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

/// @dev Canonical Permit2 AllowanceTransfer interface (subset used here).
interface IPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract BatchExecutor {
    // ── Types ────────────────────────────────────────────────────────
    struct Call {
        address target;
        uint256 value;
        bytes data;
        bool allowFailure;
    }

    // ── Errors ───────────────────────────────────────────────────────
    error NotOwner();
    error Paused();
    error ZeroAddress();
    error BatchCallFailed(uint256 index, bytes returnData);
    error NoCalls();
    error EtherSendFailed();
    error InsufficientEthForFee();
    error FeeTooLarge();
    error ArrayLengthMismatch();

    // ── Events ───────────────────────────────────────────────────────
    event BatchExecuted(address indexed sender, uint256 callCount, uint256 valueIn);
    event CallFailedAllowed(uint256 indexed index, address indexed target, bytes returnData);
    event PulledAndApproved(
        address indexed token, address indexed router, uint160 pullAmount, uint256 approveAmount
    );
    event SweptToken(address indexed token, address indexed to, uint256 amount);
    event SweptEth(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedSet(bool paused);
    event ProtocolFee(address indexed token, address indexed to, uint256 amount);

    // ── Immutables / storage ─────────────────────────────────────────
    IPermit2 public immutable permit2;
    address public immutable weth;
    address public immutable feeTo;
    uint256 public constant FEE_BPS = 25;
    uint256 private constant _BPS_DENOM = 10_000;

    address public owner;
    bool public paused;
    /// @dev Set for the duration of executeBatch so self-called
    ///      pullAndApproveRouter pulls from the trader, not owner.
    address private _payer;

    uint256 private _reentrancyLock; // 1 = unlocked, 2 = locked
    uint256 private constant _UNLOCKED = 1;
    uint256 private constant _LOCKED = 2;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Owner-direct or self-call from executeBatch (nonReentrant).
    modifier onlyOwnerOrSelf() {
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock == _LOCKED) revert("REENTRANCY");
        _reentrancyLock = _LOCKED;
        _;
        _reentrancyLock = _UNLOCKED;
    }

    constructor(address _permit2, address _weth, address _owner, address _feeTo) {
        if (
            _permit2 == address(0) || _weth == address(0) || _owner == address(0)
                || _feeTo == address(0)
        ) {
            revert ZeroAddress();
        }
        permit2 = IPermit2(_permit2);
        weth = _weth;
        feeTo = _feeTo;
        owner = _owner;
        _reentrancyLock = _UNLOCKED;
        emit OwnershipTransferred(address(0), _owner);
    }

    /// @dev Accept native refunds (WETH withdraw, router dust, etc).
    receive() external payable {}

    // ── Core: atomic batch ───────────────────────────────────────────

    /// @notice Execute a sequence of plain calls atomically (default) or with
    ///         per-call failure tolerance when `allowFailure` is set.
    ///         Takes a 25 bps protocol fee on `tradeAmount` in `feeToken`
    ///         (native ETH when `feeToken == address(0)`) to `feeTo`, then
    ///         leftover native ETH is swept back to the caller.
    ///         Permit2 pulls inside the batch come from `msg.sender` (`_payer`).
    function executeBatch(
        Call[] calldata calls,
        address[] calldata feeTokens,
        uint256[] calldata tradeAmounts
    )
        external
        payable
        whenNotPaused
        nonReentrant
    {
        if (calls.length == 0) revert NoCalls();
        if (feeTokens.length != tradeAmounts.length) revert ArrayLengthMismatch();
        _payer = msg.sender;
        for (uint256 f = 0; f < feeTokens.length; f++) {
            _collectProtocolFee(feeTokens[f], tradeAmounts[f]);
        }

        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata c = calls[i];
            if (c.target == address(0)) revert ZeroAddress();
            // Plain call only — never delegatecall.
            (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
            if (!ok) {
                if (c.allowFailure) {
                    emit CallFailedAllowed(i, c.target, ret);
                } else {
                    revert BatchCallFailed(i, ret);
                }
            }
        }

        emit BatchExecuted(msg.sender, calls.length, msg.value);
        _payer = address(0);

        // Sweep leftover native ETH after the protocol fee already left.
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = msg.sender.call{value: bal}("");
            if (!ok) revert EtherSendFailed();
        }
    }

    function _collectProtocolFee(address feeToken, uint256 tradeAmount) internal {
        uint256 fee = (tradeAmount * FEE_BPS) / _BPS_DENOM;
        if (fee == 0) return;
        if (feeToken == address(0)) {
            if (msg.value < fee) revert InsufficientEthForFee();
            (bool ok,) = feeTo.call{value: fee}("");
            if (!ok) revert EtherSendFailed();
        } else {
            if (fee > type(uint160).max) revert FeeTooLarge();
            address payer = _payer;
            if (payer == address(0)) revert ZeroAddress();
            // forge-lint: disable-next-line(unsafe-typecast) -- bounds-checked above
            permit2.transferFrom(payer, feeTo, uint160(fee), feeToken);
        }
        emit ProtocolFee(feeToken, feeTo, fee);
    }

    // ── Pull-based token sourcing (REL-6 / REL-7) ────────────────────

    /// @notice Pull `pullAmount` of `token` from the caller (owner wallet) via
    ///         Permit2, then set per-leg allowances for `router`:
    ///           - ERC20 approve(router, approveAmount) — consumed by Kyber's
    ///             MetaAggregationRouter (plain transferFrom).
    ///           - permit2.approve(token, router, ...) — consumed by
    ///             Permit2-aware routers / future paths.
    ///         Intended to be called INSIDE executeBatch (call target = this
    ///         contract) so pull + approve + swap are one atomic step.
    function pullAndApproveRouter(
        address token,
        address router,
        uint160 pullAmount,
        uint256 approveAmount,
        uint48 permit2Expiration
    ) external onlyOwnerOrSelf {
        if (token == address(0) || router == address(0)) revert ZeroAddress();

        if (pullAmount > 0) {
            address payer = _payer;
            if (payer == address(0)) revert ZeroAddress();
            // Requires: payer approved `token` to canonical Permit2 (ERC20)
            // and granted this contract a Permit2 allowance for `token`.
            // Pull from `_payer` (executeBatch msg.sender), not owner: this
            // function is self-called so msg.sender here is the contract.
            permit2.transferFrom(payer, address(this), pullAmount, token);
        }

        if (approveAmount > 0) {
            // Reset-then-set so non-standard tokens (USDT-style) behave.
            IERC20(token).approve(router, 0);
            IERC20(token).approve(router, approveAmount);
        }

        // Permit2 allowance for Permit2-aware spenders.
        // Permit2 allowance for Permit2-aware spenders. Safe cast: capped at
        // uint160.max with an explicit bounds branch (no truncation).
        uint160 amt160;
        if (approveAmount >= type(uint160).max) {
            amt160 = type(uint160).max;
        } else {
            // Safe cast: this branch guarantees approveAmount < uint160.max.
            require(approveAmount <= type(uint160).max, "approveAmount overflow");
            // forge-lint: disable-next-line(unsafe-typecast) -- bounds-checked above
            amt160 = uint160(approveAmount);
        }
        if (amt160 > 0) {
            permit2.approve(token, router, amt160, permit2Expiration);
        }

        emit PulledAndApproved(token, router, pullAmount, approveAmount);
    }

    /// @notice Wrap native ETH held by this contract into WETH. Call inside
    ///         executeBatch with `value == 0` after funding the contract, or
    ///         standalone. Wraps `amount`; use wrapAllETH() for the full balance.
    function wrapETH(uint256 amount) external onlyOwnerOrSelf {
        IWETH(weth).deposit{value: amount}();
    }

    function wrapAllETH() external onlyOwnerOrSelf {
        uint256 bal = address(this).balance;
        if (bal > 0) IWETH(weth).deposit{value: bal}();
    }

    /// @notice Unwrap WETH held by this contract into native ETH.
    function unwrapWETH(uint256 amount) external onlyOwnerOrSelf {
        IWETH(weth).withdraw(amount);
    }

    // ── Sweeps / rescue ──────────────────────────────────────────────

    /// @notice Sweep this contract's full balance of `token` to `to`.
    function sweepToken(address token, address to) external onlyOwnerOrSelf {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            // Checked, non-standard-tolerant transfer (SafeERC20 semantics:
            // accept both bool-returning and USDT-style non-returning tokens).
            (bool ok, bytes memory ret) = token.call(
                abi.encodeWithSignature("transfer(address,uint256)", to, bal)
            );
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
            emit SweptToken(token, to, bal);
        }
    }

    /// @notice Sweep this contract's native ETH to `to`.
    function sweepETH(address to) external onlyOwnerOrSelf {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            if (!ok) revert EtherSendFailed();
            emit SweptEth(to, bal);
        }
    }

    // ── Admin ────────────────────────────────────────────────────────

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
