# Autonomous Trading Implementation

> **Note (Jul 2026):** Production DB is Postgres `reloadsol_db` (Docker). Supabase is no longer used. For current ops see [OPERATOR_STATE.md](./OPERATOR_STATE.md) and Pattern ML in [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md).

## Overview

The trending tracker has been enhanced to support both **simulation** and **real trading** modes simultaneously. This unified system allows the algorithm to:

1. **Test strategies safely** in simulation mode
2. **Execute real trades** when conditions are met
3. **Run both modes in parallel** for different tokens
4. **Maintain safety mechanisms** to prevent excessive risk

## Architecture

### Unified Trade Execution System

The system uses a unified pipeline in `src/app/api/trending/track/route.ts`:

- **Simulation**: Updates database state, tracks virtual PnL.
- **Real Trading**: Signs transactions using server-side keypair, executes via Jupiter, tracks real on-chain PnL.

### Safety Mechanisms

1. **Balance Checks**: Ensures minimum SOL balance before trading.
2. **Risk Limits**: Maximum SOL at risk across all active trades.
3. **Keypair Security**: Secure keypair loading from environment variables.
4. **Circuit Breakers**: Automatic trading halt on failures or API errors.

## Configuration

### Environment Variables

```bash
# Trading safety limits
MAX_SOL_AT_RISK=1.0          # Maximum SOL that can be at risk
MIN_SOL_BALANCE=0.1          # Minimum SOL balance to maintain

# RPC configuration
RPC_URL=your_rpc_endpoint

# Trading Keypair (REQUIRED for Real Trading)
# Format: JSON array of numbers [123, 45, ...]
TRADING_KEYPAIR_JSON=[...] 
```

### Trading Mode Control

**Switch to Real Trading:**
```bash
PUT /api/trending/track?key=your_secret
{
  "isSimulated": false
  // Keypair is loaded from TRADING_KEYPAIR_JSON env var
}
```

**Switch to Simulation:**
```bash
PUT /api/trending/track?key=your_secret
{
  "isSimulated": true
}
```

## Implementation Details

### Unified Buy Operation

The `executeBuyOperationWithStrategy` function handles both modes:

- **Input**: Token data, Strategy ID, Mode ('simulation' | 'real').
- **Logic**:
  1.  Validates Strategy and Filters.
  2.  Checks Risk (Rug Pull, Liquidity).
  3.  **If Real**:
      -   Loads `TRADING_KEYPAIR_JSON`.
      -   Gets Swap Transaction from Jupiter.
      -   Signs and Sends.
      -   Confirms Transaction.
  4.  **If Simulation**:
      -   Records "virtual" entry price.
  5.  Updates Database (`trending_token_tracker`).

### Unified Sell Operation

- **Triggers**: Stop Loss (-50%), Take Profit (TP1, TP2), or Strategy Exit.
- **Logic**:
  -   Calculates PnL.
  -   **If Real**: Executes sell swap via Jupiter.
  -   Updates `trading_history` and `trending_token_tracker` status.

### Database Schema

The `TradingSimulation` JSONB column tracks:

```typescript
interface TradingSimulation {
  is_simulated: boolean        // true = simulation, false = real trading
  buy_price: number
  buy_time: string
  // Real trade details
  buy_signature?: string
  sell_signature?: string
}
```

## Safety Features

### Pre-Trade Validation

1.  **Sufficient Wallet Balance**: Checks real SOL balance.
2.  **Keypair Validity**: Ensures `TRADING_KEYPAIR_JSON` is valid.
3.  **Risk Assessment**: Calls `assessTokenRisk`.

### Risk Management

-   **Maximum Risk**: Configurable limit on total SOL at risk.
-   **Position Sizing**: Defined per strategy (e.g., 0.1 SOL).
-   **Balance Protection**: Maintains minimum SOL for fees.

### Error Handling

-   **Transaction Failures**: Graceful handling with detailed logging.
-   **Network Issues**: Retry logic with exponential backoff.
-   **Keypair Errors**: Fails safe (prevents trade).

## Monitoring & Logging

### Enhanced Logging
Real trades include additional information:
-   Transaction signatures
-   Block confirmation status
-   Fee calculations
-   Execution timing

### Discord Notifications
Notifications differentiate between:
-   🤖 **Simulated trades**: "SIM" prefix (or "💻 SIMULATION")
-   💰 **Real trades**: "REAL" prefix (or "🔥 LIVE") with signature links

## Security Considerations

### Keypair Management
-   **Environment Variable**: `TRADING_KEYPAIR_JSON` is injected at runtime.
-   **No Hardcoding**: Keypairs are never committed to code.
-   **Access Control**: Only the `track` endpoint (protected by secret key) can trigger trades.

### API Security
-   **Secret Key Protection**: Trending tracker secret key required.
-   **Rate Limiting**: Built-in rate limiting for API calls.

## Conclusion
The autonomous trading implementation provides a robust foundation for both strategy development and live trading. The unified architecture ensures consistency between simulation and real trading while maintaining strict safety controls.
