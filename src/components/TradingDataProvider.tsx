'use client'

import React, { createContext, useContext, useCallback } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tradingTracker, TrackingRecord } from '@/utils/trading-tracker'
import { useWallet } from './WalletProvider'

// Create a stable query client instance
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
})

// Trading data context
interface TradingDataContextType {
  // Records management
  records: TrackingRecord[]
  isLoadingRecords: boolean
  recordsError: string | null
  refetchRecords: () => void
  
  // Mutations
  trackOperation: (operation: Omit<TrackingRecord, 'id' | 'timestamp'>) => Promise<void>
  
  // Real-time subscription status
  isSubscribed: boolean
}

const TradingDataContext = createContext<TradingDataContextType | null>(null)

// Custom hook to use trading data
export function useTradingData() {
  const context = useContext(TradingDataContext)
  if (!context) {
    throw new Error('useTradingData must be used within TradingDataProvider')
  }
  return context
}

// Query keys
const QUERY_KEYS = {
  tradingRecords: (walletAddress: string) => ['trading-records', walletAddress],
  walletTokens: (walletAddress: string) => ['wallet-tokens', walletAddress],
} as const

// Trading records hook
export function useTradingRecords(walletAddress?: string) {
  return useQuery({
    queryKey: QUERY_KEYS.tradingRecords(walletAddress || ''),
    queryFn: async () => {
      if (!walletAddress) return []
      return await tradingTracker.getWalletRecords(walletAddress, false) // Force fresh fetch
    },
    enabled: !!walletAddress,
    staleTime: 1000 * 60 * 2, // 2 minutes for trading records
  })
}

// Track operation mutation
export function useTrackOperation() {
  const queryClient = useQueryClient()
  const { publicKey } = useWallet()
  
  return useMutation({
    mutationFn: async (operation: Omit<TrackingRecord, 'id' | 'timestamp'>) => {
      await tradingTracker.trackOperation(operation)
    },
    onSuccess: () => {
      // Invalidate and refetch trading records for the current wallet
      if (publicKey) {
        const walletAddress = publicKey.toString()
        queryClient.invalidateQueries({
          queryKey: QUERY_KEYS.tradingRecords(walletAddress)
        })
        
        // Also trigger a manual refresh after a small delay to ensure Supabase sync
        setTimeout(() => {
          queryClient.refetchQueries({
            queryKey: QUERY_KEYS.tradingRecords(walletAddress)
          })
        }, 500)
      }
    },
    onError: (error) => {
      console.error('Failed to track operation:', error)
    }
  })
}

// Trading data provider component
function TradingDataProviderInner({ children }: { children: React.ReactNode }) {
  const { publicKey, connected } = useWallet()
  const queryClient = useQueryClient()
  
  const walletAddress = connected && publicKey ? publicKey.toString() : undefined
  
  // Query for trading records
  const {
    data: records = [],
    isLoading: isLoadingRecords,
    error: recordsError,
    refetch: refetchRecords
  } = useTradingRecords(walletAddress)
  
  // Track operation mutation
  const trackOperationMutation = useTrackOperation()
  
  // Track operation wrapper
  const trackOperation = useCallback(async (operation: Omit<TrackingRecord, 'id' | 'timestamp'>) => {
    await trackOperationMutation.mutateAsync(operation)
  }, [trackOperationMutation])
  
  // Set up real-time subscription
  const [isSubscribed, setIsSubscribed] = React.useState(false)
  
  React.useEffect(() => {
    if (!walletAddress) {
      setIsSubscribed(false)
      return
    }
    
    setIsSubscribed(true)
    
    // Subscribe to real-time updates
    const unsubscribe = tradingTracker.subscribeToWallet(walletAddress, () => {
      console.log('📡 Real-time update received, invalidating queries...')
      
      // Invalidate and refetch queries
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.tradingRecords(walletAddress)
      })
      
      // Force refetch after a delay to ensure Supabase sync
      setTimeout(() => {
        queryClient.refetchQueries({
          queryKey: QUERY_KEYS.tradingRecords(walletAddress)
        })
      }, 300)
    })
    
    return () => {
      setIsSubscribed(false)
      unsubscribe()
    }
  }, [walletAddress, queryClient])
  
  const contextValue: TradingDataContextType = {
    records,
    isLoadingRecords,
    recordsError: recordsError?.message || null,
    refetchRecords,
    trackOperation,
    isSubscribed,
  }
  
  return (
    <TradingDataContext.Provider value={contextValue}>
      {children}
    </TradingDataContext.Provider>
  )
}

// Main provider that includes QueryClient
export default function TradingDataProvider({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TradingDataProviderInner>
        {children}
      </TradingDataProviderInner>
    </QueryClientProvider>
  )
}

// Export the query client for direct access if needed
export { queryClient } 