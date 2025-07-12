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
  private subscribers: Set<(records: TrackingRecord[]) => void> = new Set()
  private cache: Map<string, TrackingRecord[]> = new Map() // Per-wallet cache
  private isOnline: boolean = true

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
      this.updateLocalCache(record.walletAddress, newRecord)

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
    const response = await fetch('/api/trading/records', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(record)
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(`API insert failed: ${error.error || 'Unknown error'}`)
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
  private updateLocalCache(walletAddress: string, newRecord: TrackingRecord): void {
    const cached = this.cache.get(walletAddress) || []
    cached.unshift(newRecord)

    // Limit cache to 500 records per wallet
    if (cached.length > 500) {
      cached.splice(500)
    }

    this.cache.set(walletAddress, cached)
  }

  // Get records for specific wallet (with caching)
  async getWalletRecords(walletAddress: string, useCache: boolean = true): Promise<TrackingRecord[]> {
    // Return cached data if available and requested
    if (useCache && this.cache.has(walletAddress)) {
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

      // Fetch from API
      const response = await fetch(`/api/trading/records?wallet=${encodeURIComponent(walletAddress)}&limit=500`)

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

      const response = await fetch('/api/trading/records/all?limit=1000')

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

  // Subscribe to real-time updates for a wallet (using polling)
  subscribeToWallet(walletAddress: string, callback: (records: TrackingRecord[]) => void): () => void {
    // Add subscriber and immediately emit current cache (if any)
    this.subscribers.add(callback)
    callback(this.cache.get(walletAddress) || [])

    // Return unsubscribe function (no polling to clean up)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  // Notify subscribers of changes
  private notifySubscribers(walletAddress: string): void {
    this.subscribers.forEach(callback => {
      callback(this.cache.get(walletAddress) || [])
    })
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

    const response = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mintAddresses.join(',')}`)
    const data = await response.json()

    const prices: Record<string, number> = {}
    for (const [mintAddress, priceInfo] of Object.entries(data?.data || {})) {
      if (typeof priceInfo === 'object' && priceInfo !== null && 'price' in priceInfo) {
        prices[mintAddress] = parseFloat((priceInfo as any).price)
      }
    }

    return prices
  } catch (error) {
    console.error('Error fetching token prices for tracking:', error)
    return {}
  }
} 