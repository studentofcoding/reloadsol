// Trading Operations Tracker - API Proxy Edition
// Real-time syncing PnL tracker with offline support using API routes

export interface TrackingRecord {
  id: string
  walletAddress: string
  operationType: 'buy' | 'sell' | 'close'
  timestamp: number

  // Token information with prices and individual SOL amounts
  tokens: Array<{
    mintAddress: string
    symbol?: string
    name?: string
    logoURI?: string
    priceUsd?: number // USD price of token at operation time
    solPrice?: number // SOL price in USD at operation time
    tokenAmount?: number // Amount of tokens involved
    solAmount?: number // Individual SOL amount for this specific token (NEW)
  }>

  // Operation results
  successCount: number
  failureCount: number
  totalTokens: number

  // Financial data
  solAmount?: number // For buys: total amount spent, For sells: total amount received (kept for backward compatibility)
  feesPaid: number

  // Price tracking for accurate PnL
  solPriceUsd?: number // SOL price in USD at operation time
  totalUsdValue?: number // Total USD value of operation

  // Transaction data
  signatures: string[]

  // Additional metadata
  slippage?: number
  priorityFee?: number

  // Optional error information
  errors?: string[]

  // New fields from API improvements
  status?: 'waiting' | 'tracking' | 'won' | 'lost' | 'skipped'
  is_bot_operation?: boolean // Whether this was a bot operation
  bot_strategy?: string // Bot strategy used
  trade_comparison_data?: any // Trade comparison result
  trading_simulation?: any // Trading simulation data
  price_history?: Array<{ timestamp: string; price_usd: number; volume?: number }>
  waiting_started_at?: string | null
  waiting_initial_price?: number | null
}

export interface TrackingStats {
  totalOperations: number
  totalBuys: number
  totalSells: number
  totalCloses: number
  totalSolSpent: number
  totalSolReceived: number
  totalFeesPaid: number
  totalTokensBought: number
  totalTokensSold: number
  totalAccountsClosed: number
  successRate: number
}

class TradingTracker {
  private readonly OLD_STORAGE_KEY = 'bulk_trading_records' // For cleanup
  private pollingInterval: NodeJS.Timeout | null = null
  private subscribers: Map<string, Set<(records: TrackingRecord[]) => void>> = new Map()
  private cache: Map<string, TrackingRecord[]> = new Map() // Per-wallet cache
  private isOnline: boolean = true
  private sseConnection: EventSource | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private readonly API_HOST = process.env.API_HOST;

  constructor() {
    this.setupOnlineOfflineHandlers()
    this.clearOldLocalStorageData()
  }

  // Clear old localStorage data from previous implementation
  private clearOldLocalStorageData(): void {
    // Only run in browser environment
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return
    }

    try {
      // Clear old trading records
      localStorage.removeItem(this.OLD_STORAGE_KEY)

      // Clear other old cache data that might conflict
      const oldKeys = [
        'token_operations_cache',
        'last_sync_time',
        'trading_history_cache',
        'pnl_cache'
      ]

      oldKeys.forEach(key => {
        if (localStorage.getItem(key)) {
          localStorage.removeItem(key)
          console.log(`🧹 Cleared old cache: ${key}`)
        }
      })

      console.log('🧹 Cleared all old localStorage data - starting fresh with API!')
    } catch (error) {
      console.warn('Failed to clear old cache:', error)
    }
  }

  // Setup online/offline detection
  private setupOnlineOfflineHandlers(): void {
    if (typeof window !== 'undefined') {
      this.isOnline = navigator.onLine

      window.addEventListener('online', () => {
        this.isOnline = true
        console.log('📶 Back online - syncing cached data...')
        this.syncOfflineData()
      })

      window.addEventListener('offline', () => {
        this.isOnline = false
        console.log('📵 Gone offline - caching locally...')
      })
    }
  }

  // Add a new tracking record (with offline support)
  async trackOperation(record: Omit<TrackingRecord, 'id' | 'timestamp'>): Promise<void> {
    try {
      const newRecord: TrackingRecord = {
        ...record,
        id: this.generateId(),
        timestamp: Date.now()
      }

      if (this.isOnline) {
        // Try to save via API first
        await this.saveViaAPI(newRecord)
      } else {
        // Save to offline cache
        this.saveToOfflineCache(newRecord)
      }

      // Update local cache
      this.updateLocalCache(record.walletAddress, [newRecord])

      // Notify subscribers
      this.notifySubscribers(record.walletAddress)

      // Dispatch event for backward compatibility
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tradingRecordAdded', {
          detail: { record: newRecord, operationType: record.operationType }
        }))
      }

      console.log(`📊 Tracked ${record.operationType} operation:`, {
        wallet: record.walletAddress.slice(0, 8) + '...',
        tokens: record.totalTokens,
        success: record.successCount,
        failed: record.failureCount,
        online: this.isOnline
      })
    } catch (error) {
      console.error('Failed to track operation:', error)
      // Fallback to offline cache on error
      const newRecord: TrackingRecord = {
        ...record,
        id: this.generateId(),
        timestamp: Date.now()
      }
      this.saveToOfflineCache(newRecord)
    }
  }

  // Save record via API
  private async saveViaAPI(record: TrackingRecord): Promise<void> {
    // Use absolute URL for server-side compatibility
    const baseUrl = 'https://v2.reloadsol.xyz'
    const response = await fetch(`${baseUrl}/api/trading/records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(record)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`API insert failed: ${error.error || 'Unknown error'}`);
    }
  }

  // Save to offline cache (localStorage)
  private saveToOfflineCache(record: TrackingRecord): void {
    // Only run in browser environment
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return
    }

    try {
      const key = `offline_trading_${record.walletAddress}`
      const cached = localStorage.getItem(key)
      const records: TrackingRecord[] = cached ? JSON.parse(cached) : []

      records.unshift(record)

      // Limit offline cache to 100 records per wallet
      if (records.length > 100) {
        records.splice(100)
      }

      localStorage.setItem(key, JSON.stringify(records))
      console.log('💾 Saved to offline cache:', record.id)
    } catch (error) {
      console.error('Failed to save to offline cache:', error)
    }
  }

  // Sync offline data when back online
  private async syncOfflineData(): Promise<void> {
    // Only run in browser environment
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return
    }

    try {
      const offlineKeys = Object.keys(localStorage).filter(key =>
        key.startsWith('offline_trading_')
      )

      for (const key of offlineKeys) {
        const records: TrackingRecord[] = JSON.parse(localStorage.getItem(key) || '[]')

        for (const record of records) {
          try {
            await this.saveViaAPI(record)
            console.log('✅ Synced offline record:', record.id)
          } catch (error) {
            console.error('Failed to sync record:', record.id, error)
          }
        }

        // Clear offline cache after successful sync
        localStorage.removeItem(key)
      }

      console.log('🔄 Offline sync completed')
    } catch (error) {
      console.error('Offline sync failed:', error)
    }
  }

  // Update local cache
  private updateLocalCache(walletAddress: string, records: TrackingRecord[]): void {
    const cached = this.cache.get(walletAddress) || []

    // If we're adding new records, prepend them
    if (records.length > 0) {
      cached.unshift(...records)
    }

    // Limit cache to 500 records per wallet
    if (cached.length > 500) {
      cached.splice(500)
    }

    this.cache.set(walletAddress, cached)
  }

  // Get records for specific wallet (with caching)
  async getWalletRecords(walletAddress: string, useCache: boolean = true): Promise<TrackingRecord[]> {
    // Add diagnostic logging to identify execution context
    console.log('🔍 getWalletRecords execution context:', {
      isServer: typeof window === 'undefined',
      hasProcess: typeof process !== 'undefined',
      nodeEnv: process?.env?.NODE_ENV,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
      walletAddress: walletAddress.substring(0, 8) + '...',
      useCache,
      stackTrace: new Error().stack?.split('\n').slice(1, 4).join('\n')
    });

    // Return cached data if available and requested
    if (useCache && this.cache.has(walletAddress)) {
      console.log('📦 Returning cached data for wallet:', walletAddress.substring(0, 8) + '...');
      return this.cache.get(walletAddress) || []
    }

    try {
      // Include offline records in the query (only in browser)
      let offlineRecords: TrackingRecord[] = []
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const offlineKey = `offline_trading_${walletAddress}`
        offlineRecords = localStorage.getItem(offlineKey)
          ? JSON.parse(localStorage.getItem(offlineKey) || '[]')
          : []
      }

      if (!this.isOnline) {
        // Return only offline records when offline
        this.cache.set(walletAddress, offlineRecords)
        return offlineRecords
      }

      // Skip fetch in server-side contexts to prevent URL errors
      if (typeof window === 'undefined') {
        console.log('⚠️ Skipping fetch in server-side context, returning offline/cached data');
        this.cache.set(walletAddress, offlineRecords)
        return offlineRecords
      }

      // Fetch from API (client-side only)
      console.log('🌐 Making client-side fetch for wallet records');
      const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
      const apiUrl = `${baseUrl}/api/trading/records?wallet=${encodeURIComponent(walletAddress)}&limit=500`
      const response = await fetch(apiUrl)

      if (!response.ok) {
        console.error('Failed to fetch wallet records:', response.statusText)
        return offlineRecords // Fallback to offline records
      }

      const data = await response.json()
      const records: TrackingRecord[] = data.success ? data.records : []

      // Merge with offline records and dedupe by ID
      const merged = [...offlineRecords, ...records]
      const deduped = merged.filter((record, index, self) =>
        self.findIndex(r => r.id === record.id) === index
      )

      // Sort by timestamp (newest first)
      deduped.sort((a, b) => b.timestamp - a.timestamp)

      // Update cache
      this.cache.set(walletAddress, deduped)

      return deduped
    } catch (error) {
      console.error('Error fetching wallet records:', error)
      return this.cache.get(walletAddress) || []
    }
  }

  // Get all records (limited for performance)
  async getAllRecords(): Promise<TrackingRecord[]> {
    console.log('🔍 getAllRecords execution context:', {
      isServer: typeof window === 'undefined',
      nodeEnv: process?.env?.NODE_ENV
    });
    try {
      if (!this.isOnline) {
        // Combine all offline caches when offline (only in browser)
        let allOfflineRecords: TrackingRecord[] = []
        if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
          const offlineKeys = Object.keys(localStorage).filter(key =>
            key.startsWith('offline_trading_')
          )

          offlineKeys.forEach(key => {
            const records: TrackingRecord[] = JSON.parse(localStorage.getItem(key) || '[]')
            allOfflineRecords.push(...records)
          })
        }

        return allOfflineRecords.sort((a, b) => b.timestamp - a.timestamp)
      }

      // Skip fetch in server-side contexts
      if (typeof window === 'undefined') {
        console.log('⚠️ Skipping getAllRecords fetch in server-side context');
        return []
      }

      const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
      const apiUrl = `${baseUrl}/api/trading/records/all?limit=1000`

      const response = await fetch(apiUrl)

      if (!response.ok) {
        throw new Error(`Failed to fetch records: ${response.statusText}`)
      }

      const data = await response.json()
      return data.success ? data.records : []
    } catch (error) {
      console.error('Error fetching all records:', error)
      return []
    }
  }

  /**
   * Subscribe to real-time wallet updates using SSE with polling fallback
   */
  subscribeToWallet(walletAddress: string, callback: (records: TrackingRecord[]) => void): () => void {
    console.log(`🔔 Setting up real-time subscription for wallet: ${walletAddress.slice(0, 8)}...`)

    // Add callback to subscribers
    if (!this.subscribers.has(walletAddress)) {
      this.subscribers.set(walletAddress, new Set())
    }
    this.subscribers.get(walletAddress)!.add(callback)

    // Immediately emit cached data
    const cachedRecords = this.cache.get(walletAddress) || []
    callback(cachedRecords)

    // Set up SSE connection for real-time updates
    this.setupSSEConnection(walletAddress)

    // Fallback polling (reduced frequency when SSE is active)
    const pollInterval = setInterval(async () => {
      try {
        const records = await this.getWalletRecords(walletAddress)
        this.updateLocalCache(walletAddress, records)
        this.notifySubscribers(walletAddress)
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, this.sseConnection ? 30000 : 5000) // 30s with SSE, 5s without

    // Return cleanup function
    return () => {
      this.subscribers.get(walletAddress)?.delete(callback)
      if (this.subscribers.get(walletAddress)?.size === 0) {
        this.subscribers.delete(walletAddress)
        this.cleanupSSEConnection()
      }
      clearInterval(pollInterval)
    }
  }

  /**
   * Set up Server-Sent Events connection for real-time updates
   */
  private setupSSEConnection(walletAddress: string) {
    if (typeof window === 'undefined' || this.sseConnection) return

    try {
      const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
      const sseUrl = `${baseUrl}/api/trading/subscribe?wallet=${walletAddress}`

      this.sseConnection = new EventSource(sseUrl)

      this.sseConnection.onopen = () => {
        console.log('📡 SSE connection established')
        this.reconnectAttempts = 0
      }

      this.sseConnection.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          switch (data.type) {
            case 'connected':
              console.log('✅ SSE connected for wallet:', data.wallet?.slice(0, 8) + '...')
              break

            case 'trade_update':
            case 'pnl_update':
            case 'balance_update':
              console.log('🔄 Received trading update, refreshing data...')
              this.handleRealTimeUpdate(walletAddress)
              break

            case 'keepalive':
              // Keep connection alive
              break

            default:
              console.log('📨 SSE message:', data)
          }
        } catch (error) {
          console.error('Error parsing SSE message:', error)
        }
      }

      this.sseConnection.onerror = (error) => {
        console.error('SSE connection error:', error)
        this.handleSSEReconnect(walletAddress)
      }

    } catch (error) {
      console.error('Failed to establish SSE connection:', error)
    }
  }

  /**
   * Handle real-time update by refreshing data
   */
  private async handleRealTimeUpdate(walletAddress: string) {
    try {
      const records = await this.getWalletRecords(walletAddress)
      this.updateLocalCache(walletAddress, records)
      this.notifySubscribers(walletAddress)
    } catch (error) {
      console.error('Error handling real-time update:', error)
    }
  }

  /**
   * Handle SSE reconnection with exponential backoff
   */
  private handleSSEReconnect(walletAddress: string) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('Max SSE reconnection attempts reached, falling back to polling only')
      return
    }

    this.cleanupSSEConnection()

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++

    console.log(`Reconnecting SSE in ${delay}ms (attempt ${this.reconnectAttempts})`)

    setTimeout(() => {
      this.setupSSEConnection(walletAddress)
    }, delay)
  }

  /**
   * Clean up SSE connection
   */
  private cleanupSSEConnection() {
    if (this.sseConnection) {
      this.sseConnection.close()
      this.sseConnection = null
    }
  }

  // Notify subscribers of changes
  private notifySubscribers(walletAddress: string): void {
    const walletSubscribers = this.subscribers.get(walletAddress)
    if (walletSubscribers) {
      const records = this.cache.get(walletAddress) || []
      walletSubscribers.forEach(callback => {
        callback(records)
      })
    }
  }

  getStats(records: TrackingRecord[]): TrackingStats {
    const stats: TrackingStats = {
      totalOperations: records.length,
      totalBuys: 0,
      totalSells: 0,
      totalCloses: 0,
      totalSolSpent: 0,
      totalSolReceived: 0,
      totalFeesPaid: 0,
      totalTokensBought: 0,
      totalTokensSold: 0,
      totalAccountsClosed: 0,
      successRate: 0
    }

    let totalSuccessful = 0
    let totalAttempts = 0

    records.forEach(record => {
      switch (record.operationType) {
        case 'buy':
          stats.totalBuys++
          stats.totalSolSpent += record.solAmount || 0
          stats.totalTokensBought += record.successCount
          break
        case 'sell':
          stats.totalSells++
          stats.totalSolReceived += record.solAmount || 0
          stats.totalTokensSold += record.successCount
          break
        case 'close':
          stats.totalCloses++
          stats.totalAccountsClosed += record.successCount
          break
      }

      stats.totalFeesPaid += record.feesPaid
      totalSuccessful += record.successCount
      totalAttempts += record.totalTokens
    })

    stats.successRate = totalAttempts > 0 ? (totalSuccessful / totalAttempts) * 100 : 0

    return stats
  }

  // Clear all data (for testing/debugging)
  async clearAllData(): Promise<void> {
    try {
      // Clear local cache
      this.cache.clear()

      // Clear offline storage
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const offlineKeys = Object.keys(localStorage).filter(key =>
          key.startsWith('offline_trading_')
        )
        offlineKeys.forEach(key => localStorage.removeItem(key))
      }

      console.log('🧹 Cleared all trading tracker data')
    } catch (error) {
      console.error('Failed to clear data:', error)
    }
  }

  // Generate unique ID
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}

// Export singleton instance
export const tradingTracker = new TradingTracker()

// Helper functions for backward compatibility
export const trackBuyOperation = (
  walletAddress: string,
  tokens: Array<{
    mintAddress: string;
    symbol?: string;
    name?: string;
    logoURI?: string;
    priceUsd?: number;
    tokenAmount?: number;
  }>,
  solAmount: number,
  successCount: number,
  failureCount: number,
  signatures: string[],
  feesPaid: number,
  slippage?: number,
  priorityFee?: number,
  errors?: string[],
  solPriceUsd?: number
) => {
  return tradingTracker.trackOperation({
    walletAddress,
    operationType: 'buy',
    tokens: tokens.map(token => ({
      ...token,
      solPrice: solPriceUsd
    })),
    successCount,
    failureCount,
    totalTokens: successCount + failureCount,
    solAmount,
    feesPaid,
    solPriceUsd,
    totalUsdValue: solPriceUsd ? solAmount * solPriceUsd : undefined,
    signatures,
    slippage,
    priorityFee,
    errors
  })
}

export const trackSellOperation = (
  walletAddress: string,
  tokens: Array<{
    mintAddress: string;
    symbol?: string;
    name?: string;
    logoURI?: string;
    priceUsd?: number;
    tokenAmount?: number;
  }>,
  solReceived: number,
  successCount: number,
  failureCount: number,
  signatures: string[],
  feesPaid: number,
  slippage?: number,
  priorityFee?: number,
  errors?: string[],
  solPriceUsd?: number
) => {
  return tradingTracker.trackOperation({
    walletAddress,
    operationType: 'sell',
    tokens: tokens.map(token => ({
      ...token,
      solPrice: solPriceUsd
    })),
    successCount,
    failureCount,
    totalTokens: successCount + failureCount,
    solAmount: solReceived,
    feesPaid,
    solPriceUsd,
    totalUsdValue: solPriceUsd ? solReceived * solPriceUsd : undefined,
    signatures,
    slippage,
    priorityFee,
    errors
  })
}

export const trackCloseOperation = (
  walletAddress: string,
  tokens: Array<{ mintAddress: string; symbol?: string; name?: string; logoURI?: string }>,
  successCount: number,
  failureCount: number,
  signatures: string[],
  feesPaid: number,
  errors?: string[],
  solPriceUsd?: number
) => {
  return tradingTracker.trackOperation({
    walletAddress,
    operationType: 'close',
    tokens: tokens.map(token => ({
      ...token,
      solPrice: solPriceUsd
    })),
    successCount,
    failureCount,
    totalTokens: successCount + failureCount,
    feesPaid,
    solPriceUsd,
    signatures,
    errors
  })
}

// Fetch token prices for tracking
export const fetchTokenPricesForTracking = async (mintAddresses: string[]): Promise<Record<string, number>> => {
  try {
    if (mintAddresses.length === 0) return {}

    // Use the new Jupiter API utility
    const { getTokenPrices } = await import('./jupiter-api')
    const prices = await getTokenPrices(mintAddresses)

    return prices
  } catch (error) {
    console.error('Error fetching token prices for tracking:', error)
    return {}
  }
}