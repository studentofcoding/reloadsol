# Swap Worker - Cloudflare Worker for Token Swaps

This Cloudflare Worker handles token swap operations using the SolanaTracker API, providing a server-side solution for better rate limiting and performance.

## Why Use FLUXBEAM_KEY Instead of Full RPC URL?

The `FLUXBEAM_KEY` is stored as an environment variable for future flexibility, but **currently we don't use it** in the swap operations. Here's why:

1. **Current Architecture**: We use SolanaTracker's swap API (`https://swap-v2.solanatracker.io/swap`) which handles all RPC operations internally
2. **Future Flexibility**: The FLUXBEAM_KEY is kept ready for potential direct Solana RPC calls if needed
3. **Security**: Using just the key instead of full URL keeps configuration cleaner
4. **Rate Limiting**: SolanaTracker handles rate limiting better than direct RPC calls

## Automatic Fallback System

The client automatically handles failures with intelligent fallback:

1. **Primary**: Try Cloudflare Worker first
2. **Health Tracking**: Cache worker health status for 30 seconds
3. **Smart Retry**: Skip unhealthy workers but retry 10% of the time
4. **Automatic Fallback**: Use SolanaTracker directly if worker fails
5. **Timeout Protection**: 10-second timeout prevents hanging requests

### Fallback Behavior

```javascript
// Automatic fallback sequence:
1. Try Cloudflare Worker (if healthy)
2. If worker fails → Mark as unhealthy → Use SolanaTracker
3. If both fail → Throw detailed error
4. Health status cached for 30s to avoid repeated checks
```

## Setup Instructions

### 1. Install Dependencies

```bash
cd swap-worker
npm install
```

### 2. Configure Environment Variables

Edit `wrangler.toml` or use Wrangler secrets for production:

```bash
# For development (already in wrangler.toml)
DEV_FEE_WALLET = "3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX"
FLUXBEAM_KEY = "94a42d66-8cc7-454a-9d33-513cff867307"

# For production (recommended)
wrangler secret put DEV_FEE_WALLET
wrangler secret put FLUXBEAM_KEY
```

### 3. Deploy to Cloudflare

```bash
# Deploy to production
npm run deploy

# Or for development
npm run dev
```

### 4. Update Frontend Configuration

Add your worker URL to your Next.js environment variables:

```bash
# .env.local
NEXT_PUBLIC_SWAP_WORKER_URL=https://swap-worker.your-subdomain.workers.dev
```

**Note**: If you don't set `NEXT_PUBLIC_SWAP_WORKER_URL`, the system will automatically use SolanaTracker directly as a fallback.

## API Usage

The worker accepts POST requests with the following body:

```json
{
  "direction": "buy" | "sell",
  "mint": "token_mint_address",
  "amount": 0.02,           // SOL units
  "slippage": 0.5,          // 0.5%
  "payer": "user_wallet_address",
  "priorityFee": 0.001      // SOL units
}
```

Response:
```json
{
  "txn": "base64_encoded_transaction"
}
```

## Benefits of This Architecture

1. **Better Rate Limiting**: 3M requests/month vs 125k on Vercel
2. **Lower Latency**: Edge deployment closer to users
3. **Cost Effective**: Free tier handles 1000+ users easily
4. **Scalable**: Auto-scales with demand
5. **Reliable**: Built-in retry and error handling + automatic fallback
6. **Fault Tolerant**: Continues working even if Worker is down

## Monitoring

Use Wrangler to monitor your worker:

```bash
# View logs
npm run tail

# Check deployment status
wrangler deployments list

# Check worker health from your app
import { checkSwapWorkerHealth } from '@/utils/swap-client'
const health = await checkSwapWorkerHealth()
console.log('Worker health:', health)
```

## Environment Variables Explained

- `DEV_FEE_WALLET`: Wallet address that receives 0.5% fees from swaps
- `FLUXBEAM_KEY`: RPC key for future direct Solana operations (currently unused)

## Deployment Modes

### Development Mode
- Worker URL not set → Uses SolanaTracker directly
- Fast setup, no deployment needed

### Production Mode
- Worker URL set → Uses Cloudflare Worker with SolanaTracker fallback
- Better performance and rate limiting

The worker currently relies on SolanaTracker's infrastructure for all RPC operations, making it more reliable than direct RPC calls while maintaining the flexibility to switch to direct RPC if needed in the future. 