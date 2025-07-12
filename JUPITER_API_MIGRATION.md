# Jupiter API v2 to v3 Migration Guide

## Overview

This project has been migrated from Jupiter's Price API v2 to v3 to take advantage of enhanced price data and improved reliability. The migration includes a centralized API utility that abstracts the API version and provides backward compatibility.

## What Changed

### API Response Format

**v2 Response:**
```json
{
  "data": {
    "So11111111111111111111111111111111111111112": {
      "id": "So11111111111111111111111111111111111111112",
      "type": "derivedPrice",
      "price": "158.922802500"
    }
  },
  "timeTaken": 0.002122031
}
```

**v3 Response:**
```json
{
  "So11111111111111111111111111111111111111112": {
    "usdPrice": 158.73960816152,
    "blockId": 352849623,
    "decimals": 9,
    "priceChange24h": -2.69564285608502
  }
}
```

### Enhanced Data Available

v3 provides additional data points:
- **decimals**: Token decimal places
- **priceChange24h**: 24-hour price change percentage
- **blockId**: Latest block ID for price data
- **Direct price format**: No need to parse string prices

## New Centralized API Utility

### Location
`src/utils/jupiter-api.ts`

### Key Features
- **Version abstraction**: Switch between v2/v3 without code changes
- **Automatic response normalization**: Consistent data format regardless of API version
- **Enhanced error handling**: Specific error types and retry logic
- **Batch processing**: Efficient handling of large token lists
- **Rate limiting**: Built-in protection against API limits

### Usage Examples

#### Basic Price Fetching
```typescript
import { getTokenPrice, getTokenPrices } from '@/utils/jupiter-api'

// Single token price
const solPrice = await getTokenPrice('So11111111111111111111111111111111111111112')

// Multiple token prices
const prices = await getTokenPrices([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // USDC
])
```

#### Enhanced Price Data
```typescript
import { fetchTokenPrices } from '@/utils/jupiter-api'

const priceData = await fetchTokenPrices(['So11111111111111111111111111111111111111112'])

// Access enhanced data
const solData = priceData['So11111111111111111111111111111111111111112']
console.log({
  price: solData.price,
  decimals: solData.decimals,
  priceChange24h: solData.priceChange24h,
  blockId: solData.blockId,
  source: solData.source // 'v2' or 'v3'
})
```

#### Batch Processing
```typescript
import { fetchTokenPricesBatch } from '@/utils/jupiter-api'

// Handles large token lists automatically
const prices = await fetchTokenPricesBatch(largeTokenList, {
  batchSize: 100,
  batchDelay: 100,
  timeout: 10000,
  retries: 3
})
```

## Migration Commands

### Available Scripts
```bash
# Test migration compatibility
npm run migrate:test

# Test fallback mechanism
npm run test:fallback

# Migrate to v3 (already completed)
npm run migrate:v3

# Rollback to v2 if needed
npm run migrate:rollback

# Check current status
npm run migrate:status

# Validate migration completeness
npm run migrate:validate
```

### Migration Status
✅ **COMPLETED** - The project now uses Jupiter API v3 exclusively

### Current Configuration
- **Primary Version**: v3 (Jupiter API v3 only)
- **Fallback Version**: v2 (disabled)
- **Auto-Fallback**: ❌ Disabled (v3 only mode)
- **Error Logging**: ✅ Comprehensive server-side logging

## Files Updated

The following files have been updated to use the centralized API utility:

- ✅ `src/utils/jupiter-api.ts` - New centralized API utility
- ✅ `src/utils/jupiter-migration.ts` - Migration utilities
- ✅ `src/app/api/tokens/prices/route.ts` - API route updated
- ✅ `src/utils/jupiter.ts` - Core Jupiter utilities updated
- ✅ `src/components/PnLTracker.tsx` - PnL tracking updated
- ✅ `src/utils/trading-tracker.ts` - Trading tracker updated
- ✅ `src/utils/jupiter-pools-test.ts` - Pool testing updated
- ✅ `scripts/migrate-jupiter-api.js` - Migration script
- ✅ `package.json` - Migration commands added

## Intelligent Fallback System

### How It Works
The system now uses an intelligent fallback mechanism:

1. **Primary Attempt**: Always tries v2 first (more stable, widely tested)
2. **Automatic Fallback**: If v2 fails, automatically switches to v3
3. **Comprehensive Logging**: All failures and fallbacks are logged for monitoring
4. **Transparent Operation**: Your code doesn't need to change - fallback is automatic

### Fallback Triggers
The system falls back to v3 when v2 experiences:
- HTTP errors (4xx, 5xx status codes)
- Network timeouts
- Connection failures
- Rate limiting (429 errors)
- Service unavailable (503 errors)

### Error Logging
When fallback occurs, you'll see detailed logs:
```
[Jupiter API] Primary version v2 failed: {
  error: "HTTP 503: Service Unavailable",
  statusCode: 503,
  tokenCount: 5,
  timestamp: "2024-01-15T10:30:00.000Z"
}
[Jupiter API] Attempting fallback to version v3...
[Jupiter API] Successfully fell back to version v3 {
  tokenCount: 5,
  timestamp: "2024-01-15T10:30:01.200Z"
}
```

## Configuration Management

### Fallback Configuration
```typescript
import { 
  getFallbackConfig, 
  setJupiterApiVersion, 
  setJupiterApiFallbackVersion,
  setAutoFallback 
} from '@/utils/jupiter-api'

// Check current configuration
const config = getFallbackConfig()
console.log(config)
// {
//   primaryVersion: 'v2',
//   fallbackVersion: 'v3', 
//   autoFallback: true
// }

// Change primary version
setJupiterApiVersion('v3') // Now v3 is primary

// Change fallback version  
setJupiterApiFallbackVersion('v2') // Now v2 is fallback

// Disable auto-fallback (not recommended)
setAutoFallback(false)
```

### Legacy API Version Management
```typescript
import { setJupiterApiVersion, getJupiterApiVersion } from '@/utils/jupiter-api'

// Check current primary version
const currentVersion = getJupiterApiVersion() // 'v2'

// Switch primary version
setJupiterApiVersion('v3') // Changes primary to v3
```

### Testing Both Versions
```typescript
import { testApiVersions } from '@/utils/jupiter-api'

const testTokens = ['So11111111111111111111111111111111111111112']
const comparison = await testApiVersions(testTokens)

console.log(comparison.v2) // v2 results
console.log(comparison.v3) // v3 results
console.log(comparison.comparison) // Price differences
```

## Error Handling

### New Error Types
```typescript
import { JupiterAPIError } from '@/utils/jupiter-api'

try {
  const prices = await getTokenPrices(tokens)
} catch (error) {
  if (error instanceof JupiterAPIError) {
    console.log('Status Code:', error.statusCode)
    console.log('Is Rate Limited:', error.isRateLimit)
    console.log('Message:', error.message)
  }
}
```

## Backward Compatibility

The migration maintains full backward compatibility:

- All existing function signatures work unchanged
- Price values are returned in the same format (USD numbers)
- Error handling is enhanced but non-breaking
- Existing caching mechanisms continue to work

## Performance Improvements

### v3 Advantages
- **Faster response times**: Simplified JSON structure
- **More accurate data**: Direct numeric prices (no string parsing)
- **Enhanced metadata**: Decimals and 24h change data
- **Better rate limiting**: Improved API infrastructure

### Caching Strategy
The existing price caching in `price-client.ts` continues to work and now benefits from:
- More reliable price data
- Enhanced metadata for better cache decisions
- Improved error handling for cache fallbacks

## Monitoring and Validation

### Post-Migration Checklist
- [ ] Monitor application logs for any price-related errors
- [ ] Verify PnL calculations are accurate
- [ ] Check trading operations complete successfully
- [ ] Validate price displays in UI components
- [ ] Test bulk buy/sell operations

### Manual Verification
```bash
# Search for any remaining v2 API calls
grep -r "lite-api.jup.ag/price/v2" src/

# Should return no results if migration is complete
```

## Rollback Procedure

If issues arise, you can quickly rollback:

```bash
# Automatic rollback
npm run migrate:rollback

# Manual rollback
# Edit src/utils/jupiter-api.ts and change:
# VERSION: 'v2' as 'v2' | 'v3'
```

## Support and Troubleshooting

### Common Issues

1. **Price Discrepancies**
   - Small differences (<1%) are normal between v2/v3
   - Use `npm run migrate:test` to compare prices

2. **Rate Limiting**
   - v3 has improved rate limits
   - The utility includes automatic retry logic

3. **Missing Price Data**
   - Some tokens may not be available in v3 yet
   - The utility falls back to 0 price for missing tokens

### Debug Mode
```typescript
// Enable detailed logging
const prices = await fetchTokenPrices(tokens, {
  retries: 3,
  timeout: 15000
})
// Check console for detailed request/response logs
```

## Future Enhancements

With v3 migration complete, future enhancements can leverage:
- 24-hour price change data for trend analysis
- Decimal precision for accurate calculations
- Block ID for real-time price validation
- Enhanced error reporting for better UX

---

**Migration completed on:** [Current Date]
**API Version:** v3
**Status:** ✅ Production Ready