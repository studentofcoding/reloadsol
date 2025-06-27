# React Query Migration & Data Flow Improvements

## Problem Statement

The trading data flow between `PnLTracker.tsx`, `TradingHistory.tsx`, `BulkTokenBuyer.tsx`, and `BulkTokenSeller.tsx` was inconsistent and causing sync issues:

1. **Dual Tracking Systems**: Components were using both server-side tracking (for points) and client-side tracking (for PnL/history)
2. **Inconsistent Data Sources**: Different components relied on different data sources
3. **Real-time Update Issues**: PnLTracker wasn't receiving updates from bulk operations properly
4. **Manual Event Handling**: Complex event-based system prone to timing issues

## Solution Implemented

### 1. Centralized Data Management with React Query

**New File**: `src/components/TradingDataProvider.tsx`
- Centralized trading data management using `@tanstack/react-query`
- Single source of truth for all trading records
- Automatic caching, invalidation, and real-time updates
- Built-in loading states and error handling

### 2. Unified Tracking System

**Before**: 
```typescript
// Server-side tracking (points only)
await trackBuy(walletAddress, successCount, options)

// Client-side tracking (PnL/history)
trackBuyOperation(walletAddress, tokenData, ...)
```

**After**:
```typescript
// Server-side tracking (points only) - unchanged
await trackBuy(walletAddress, successCount, options)

// Centralized tracking (PnL/history/real-time) via React Query
await trackOperation({
  walletAddress,
  operationType: 'buy',
  tokens: enhancedTokenData,
  // ... other properties
})
```

### 3. Component Updates

#### BulkTokenBuyer.tsx
- Removed direct `trading-tracker` imports
- Uses `useTradingData()` hook for centralized tracking
- Simplified operation tracking with automatic React Query sync

#### BulkTokenSeller.tsx  
- Same pattern as BulkTokenBuyer - centralized tracking
- Removed dual tracking system complexity
- Automatic PnL updates via React Query invalidation

#### PnLTracker.tsx
- Uses React Query data via `useTradingData()` hook
- Removed manual event listeners and real-time subscriptions
- Automatic recalculation when `records` data changes
- Fast sell operations now trigger automatic PnL refresh

#### TradingHistory.tsx
- Migrated to use React Query data source
- Removed manual data loading and event handling
- Simplified stats calculation without `tradingTracker.getStats()`

### 4. Real-time Updates

**Before**: Manual event dispatching and subscription management
```typescript
window.dispatchEvent(new CustomEvent('tradingRecordAdded', {...}))
tradingTracker.subscribeToWallet(walletAddress, callback)
```

**After**: Automatic React Query invalidation and refetch
```typescript
// Automatic via React Query mutations
queryClient.invalidateQueries({
  queryKey: QUERY_KEYS.tradingRecords(walletAddress)
})
```

### 5. Data Flow Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ BulkTokenBuyer  │───▶│ TradingDataProvider │◀───│ PnLTracker      │
└─────────────────┘    │ (React Query)      │    └─────────────────┘
                       │                    │    
┌─────────────────┐    │ - Centralized Data │    ┌─────────────────┐
│ BulkTokenSeller │───▶│ - Auto Caching     │◀───│ TradingHistory  │
└─────────────────┘    │ - Real-time Sync   │    └─────────────────┘
                       │ - Loading States   │
                       └──────────────────┘
                                │
                       ┌──────────────────┐
                       │ Supabase        │
                       │ (via trading-    │
                       │  tracker.ts)     │
                       └──────────────────┘
```

## Benefits

### 1. **Consistent Data Flow**
- All components use the same data source
- Automatic synchronization between components
- No more dual tracking systems

### 2. **Improved Performance**
- React Query caching reduces redundant API calls
- Intelligent background updates
- Optimistic updates for better UX

### 3. **Better Developer Experience**
- Centralized loading and error states
- Simplified component logic
- Type-safe data management

### 4. **Real-time Synchronization**
- PnLTracker automatically updates when operations occur in bulk components
- TradingHistory shows real-time operation updates
- No manual event handling required

### 5. **Maintainability**
- Single responsibility principle - each component focuses on its UI
- Centralized data logic in TradingDataProvider
- Easier to debug and extend

## Migration Steps Completed

1. ✅ Installed `@tanstack/react-query`
2. ✅ Created `TradingDataProvider` with centralized data management
3. ✅ Added provider to root layout
4. ✅ Updated BulkTokenBuyer to use centralized tracking
5. ✅ Updated BulkTokenSeller to use centralized tracking  
6. ✅ Migrated PnLTracker to React Query data source
7. ✅ Migrated TradingHistory to React Query data source
8. ✅ Removed manual event listeners and subscriptions
9. ✅ Fixed TypeScript compilation errors
10. ✅ Maintained server-side points tracking system

## Key Features

- **Automatic Data Sync**: All components automatically receive updates
- **Optimized Caching**: 2-minute stale time for trading records
- **Real-time Updates**: Supabase real-time subscriptions integrated with React Query
- **Error Handling**: Centralized error states and retry logic
- **Loading States**: Built-in loading indicators
- **Type Safety**: Full TypeScript support with proper interfaces

## Usage

### For Component Developers
```typescript
import { useTradingData } from '@/components/TradingDataProvider'

function MyComponent() {
  const { 
    records, 
    isLoadingRecords, 
    recordsError, 
    trackOperation 
  } = useTradingData()
  
  // Use records for display
  // Use trackOperation for new operations
  // Loading/error states handled automatically
}
```

### For Trading Operations
```typescript
// Track any operation with automatic sync
await trackOperation({
  walletAddress: publicKey.toString(),
  operationType: 'buy' | 'sell' | 'close',
  tokens: enhancedTokenData,
  successCount,
  failureCount,
  // ... other properties
})
// All components will automatically update
```

This migration eliminates the sync issues between PnLTracker and other components while providing a more robust, performant, and maintainable data management system. 