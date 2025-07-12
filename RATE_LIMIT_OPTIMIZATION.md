# Rate Limit Optimization for Jupiter Price API

## Problem
- **Jupiter Lite API**: 60 requests per minute
- **Usage**: 500 users × 5-20 tokens each = 2,500-10,000 token price requests
- **Result**: Frequent 429 rate limit errors

## Solution Overview

### **Multi-Layer Caching & Batching System**

```
Client Request → Client Cache → Server Batch Queue → Server Cache → Jupiter API
     ↓              ↓              ↓                   ↓             ↓
  Instant       90s cache      100ms batching      2-5min cache   Rate limited
```

## **Implementation**

### 1. **Server-Side API** (`/api/tokens/prices`)

**Features:**
- ✅ **Request Batching**: Aggregates multiple client requests into single Jupiter calls
- ✅ **Smart Caching**: 2-5 minutes server cache (popular tokens get longer cache)
- ✅ **Rate Limiting**: Tracks 55/60 requests per minute with automatic backoff
- ✅ **Stale Cache Fallback**: Uses 10-minute stale data when rate limited

**Usage:**
```typescript
// POST request for multiple tokens
const response = await fetch('/api/tokens/prices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    tokens: ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] 
  })
})

const data = await response.json()
// Returns: { prices: { "So111...": 145.32, "EPjFW...": 1.001 }, cached_tokens: 1, fresh_tokens: 1 }
```

### 2. **Client-Side Price Client** (`src/utils/price-client.ts`)

**Features:**
- ✅ **Client Caching**: 90-180 seconds local cache
- ✅ **Request Deduplication**: Multiple requests for same token return same promise
- ✅ **Auto-Batching**: Aggregates requests for 50ms before sending to server
- ✅ **Pre-warming**: Caches popular tokens proactively

**Usage:**
```typescript
import { getTokenPrice, getTokenPrices, preWarmPriceCache } from '@/utils/price-client'

// Single token price
const solPrice = await getTokenPrice('So11111111111111111111111111111111111111112')

// Multiple tokens (batched automatically)
const prices = await getTokenPrices([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
])

// Pre-warm cache on app startup
await preWarmPriceCache(['token1', 'token2'])
```

### 3. **React Hook Integration**

```typescript
import { usePriceClient } from '@/utils/price-client'

function TokenDisplay({ tokens }: { tokens: string[] }) {
  const { getTokenPrices } = usePriceClient()
  const [prices, setPrices] = useState<Record<string, number>>({})
  
  useEffect(() => {
    getTokenPrices(tokens).then(setPrices)
  }, [tokens])
  
  return (
    <div>
      {tokens.map(token => (
        <div key={token}>
          {token}: ${prices[token] || 'Loading...'}
        </div>
      ))}
    </div>
  )
}
```

## **Performance Optimization**

### **Cache Strategy**
```typescript
// Popular tokens (SOL, USDC, USDT): 5-minute server cache, 180s client cache
// Regular tokens: 2-minute server cache, 90s client cache
// Stale fallback: 10-minute server stale cache
```

### **Batching Strategy**
```typescript
// Client: 50ms aggregation window, 100 token max batch
// Server: 100ms aggregation window, processes all pending requests
// Jupiter: Up to 100 tokens per API call (max efficiency)
```

### **Rate Limiting**
```typescript
// Server tracks: 55/60 requests per minute (5 request buffer)
// Auto-backoff: When rate limited, uses stale cache + waits for reset
// Client respects: Server rate limits, uses local cache aggressively
```

## **Migration Steps**

### **Step 1: Replace Direct Jupiter Calls**
```typescript
// OLD: Direct Jupiter API calls
const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${tokens.join(',')}`)

// NEW: Use price client
import { getTokenPrices } from '@/utils/price-client'
const prices = await getTokenPrices(tokens)
```

### **Step 2: Update Components**
```typescript
// Replace existing price fetching with new client
// The client handles batching, caching, and rate limiting automatically
```

### **Step 3: Pre-warm Cache**
```typescript
// In your app initialization
import { preWarmPriceCache } from '@/utils/price-client'

// Pre-warm with user's common tokens
await preWarmPriceCache(['So11111111111111111111111111111111111111112']) // SOL
```

## **Expected Performance**

### **Before Optimization**
- 500 users × 10 tokens = 5,000 individual API calls
- 5,000 calls ÷ 60 per minute = **83 minutes** to serve all users
- Result: **Constant 429 errors**

### **After Optimization**
- Server cache hit rate: ~80% (due to popular tokens + recent fetches)
- Client cache hit rate: ~70% (due to 90s cache + user behavior)
- **Effective API calls**: 5,000 × 0.2 × 0.3 = **300 calls**
- **Batching efficiency**: 300 calls ÷ 100 tokens per batch = **3 API calls**
- **Time to serve**: **3 calls = 3 seconds**

## **Monitoring & Debugging**

### **Server-Side Monitoring**
```typescript
// Check API rate limit status
GET /api/tokens/prices?tokens=So11111111111111111111111111111111111111112

// Response includes:
{
  "prices": { "So111...": 145.32 },
  "cached_tokens": 1,
  "fresh_tokens": 0,
  "rate_limit_remaining": 54,
  "cache_stats": {
    "total_cached": 150,
    "popular_tokens": 5
  }
}
```

### **Client-Side Monitoring**
```typescript
import { getPriceCacheStats } from '@/utils/price-client'

const stats = getPriceCacheStats()
console.log('Client cache stats:', stats)
// { cacheSize: 25, popularTokensCached: 4, hitRate: 0.85 }
```

## **Scaling Further**

### **Option 1: Upgrade to Jupiter Pro**
- **Rate Limit**: 600 requests/minute (10x increase)
- **Cost**: Paid tier
- **Benefit**: Supports 5,000+ concurrent users

### **Option 2: Redis Cache**
```typescript
// Replace in-memory cache with Redis for multi-server deployments
// Shared cache across all server instances
```

### **Option 3: Background Price Updates**
```typescript
// Cron job to pre-fetch popular token prices every minute
// Reduces real-time API calls further
```

## **Security Considerations**

✅ **Input Validation**: Token addresses validated before processing  
✅ **Rate Limiting**: Prevents API abuse  
✅ **Error Handling**: Graceful degradation with stale cache  
✅ **Cache Poisoning**: Timestamp validation prevents invalid data  
✅ **Memory Management**: Cache size limits and TTL cleanup  

## **Troubleshooting**

### **Issue: Still getting 429 errors**
**Solution**: Check if multiple services are using Jupiter API simultaneously

### **Issue: Stale prices**
**Solution**: Reduce cache TTL or force cache refresh for specific tokens

### **Issue: High memory usage**
**Solution**: Implement cache size limits and cleanup old entries

## **Testing the System**

```bash
# Test server endpoint
curl -X POST http://localhost:3000/api/tokens/prices \
  -H "Content-Type: application/json" \
  -d '{"tokens":["So11111111111111111111111111111111111111112"]}'

# Load test with 500 concurrent requests
npx autocannon -c 500 -d 30 http://localhost:3000/api/tokens/prices \
  -H "Content-Type: application/json" \
  -b '{"tokens":["So11111111111111111111111111111111111111112"]}'
```

This system should handle **500+ concurrent users** without hitting Jupiter's rate limits while maintaining fast response times through intelligent caching and batching. 