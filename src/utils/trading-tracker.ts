// Trading Operations Tracker - API Proxy Edition
// Real-time syncing PnL tracker with offline support using API routes

export interface TrackingRecord {
  id: string
  walletAddress: string
  operationType: 'buy' | 'sell' | 'close'
  timestamp: number
  /** App network — sol | robinhood. Defaults to sol when omitted (legacy rows). */
  chain?: 'sol' | 'robinhood'

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

  // On-chain settlement state for a submitted swap: pending until the tx
  // receipt resolves, then confirmed (receipt success) or failed (revert).
  txStatus?: 'pending' | 'confirmed' | 'failed'

  // New fields from API improvements
  status?: 'waiting' | 'tracking' | 'won' | 'lost' | 'skipped'
  is_bot_operation?: boolean // Whether this was a bot operation
  bot_strategy?: string // Bot strategy used
  is_simulation?: boolean // Whether this is a simulation
  simulation_type?: 'manual' | 'strategy' // Type of simulation
  close_position?: boolean // Force-close sim cycle (full exit)
  trade_comparison_data?: any // Trade comparison result
  trading_simulation?: any // Trading simulation data
  price_history?: Array<{ timestamp: string; price_usd: number; volume?: number }>
  waiting_started_at?: string | null
  waiting_initial_price?: number | null

  // ✅ NEW: Jupiter Terminal specific fields
  jupiter_swap?: boolean // Whether this was a Jupiter Terminal swap
  swap_route?: string // Jupiter swap route information
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
  private cache: Map<string, TrackingRecord[]> = new Map() // Per-wallet-per-chain cache
  private isOnline: boolean = true
  private sseConnection: EventSource | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private readonly API_HOST = typeof process !== 'undefined' ? process.env.API_HOST : undefined;

  /** Cache key is wallet + chain so SOL and Robinhood records never mix. */
  private cacheKey(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol'): string {
    return `${walletAddress}:${chain}`
  }

  /** localStorage offline key is wallet + chain so offline records never mix chains. */
  private offlineKey(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol'): string {
    return `offline_trading_${chain}_${walletAddress}`
  }

  // ✅ NEW: Connection state management
  private connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected'
  private currentWallet: string | null = null
  private reconnectTimeout: NodeJS.Timeout | null = null
  private connectionDebounceTimeout: NodeJS.Timeout | null = null
  private lastConnectionAttempt = 0
  private readonly CONNECTION_DEBOUNCE_MS = 1000 // Prevent rapid reconnections
  private lastMessageTime: number = 0
  private healthCheckInterval: NodeJS.Timeout | null = null
  private sseStateListeners = new Set<(connected: boolean) => void>()

  constructor() {
    this.setupOnlineOfflineHandlers()
    this.clearOldLocalStorageData()
  }

  isSSEConnected(): boolean {
    return this.connectionState === 'connected'
  }

  onSSEStateChange(cb: (connected: boolean) => void): () => void {
    this.sseStateListeners.add(cb)
    cb(this.isSSEConnected())
    return () => {
      this.sseStateListeners.delete(cb)
    }
  }

  private setConnectionState(
    state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting',
  ): void {
    const wasConnected = this.connectionState === 'connected'
    this.connectionState = state
    const isConnected = state === 'connected'
    if (wasConnected !== isConnected) {
      for (const cb of Array.from(this.sseStateListeners)) {
        try {
          cb(isConnected)
        } catch {
          // ignore listener errors
        }
      }
    }
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
  async trackOperation(record: Omit<TrackingRecord, 'id' | 'timestamp'>): Promise<TrackingRecord> {
    const newRecord: TrackingRecord = {
      ...record,
      id: this.generateId(),
      timestamp: Date.now(),
    }

    try {
      if (this.isOnline) {
        await this.saveViaAPI(newRecord)
      } else {
        this.saveToOfflineCache(newRecord)
      }

      this.updateLocalCache(record.walletAddress, [newRecord], newRecord.chain ?? 'sol')
      this.notifySubscribers(record.walletAddress, newRecord.chain ?? 'sol')

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('tradingRecordAdded', {
            detail: { record: newRecord, operationType: record.operationType },
          }),
        )
      }

      console.log(`📊 Tracked ${record.operationType} operation:`, {
        wallet: record.walletAddress.slice(0, 8) + '...',
        tokens: record.totalTokens,
        success: record.successCount,
        failed: record.failureCount,
        online: this.isOnline,
      })

      return newRecord
    } catch (error) {
      console.error('Failed to track operation:', error)

      if (!this.isOnline) {
        this.saveToOfflineCache(newRecord)
        this.updateLocalCache(record.walletAddress, [newRecord], newRecord.chain ?? 'sol')
        this.notifySubscribers(record.walletAddress, newRecord.chain ?? 'sol')
        return newRecord
      }

      throw error
    }
  }

  /**
   * Update an existing record (e.g. promote a pending swap to confirmed/failed
   * once its on-chain receipt resolves). Merges the patch over the cached
   * record, persists via the server action (online) or offline cache, and
   * notifies subscribers so the history feed refreshes to the terminal state.
   */
  async updateRecord(
    recordId: string,
    patch: Partial<Omit<TrackingRecord, 'id' | 'timestamp'>>,
    walletAddress: string,
    chain: 'sol' | 'robinhood' = 'sol',
  ): Promise<TrackingRecord> {
    const cached = this.cache.get(this.cacheKey(walletAddress, chain)) || []
    const existing = cached.find((r) => r.id === recordId)
    const merged: TrackingRecord = {
      ...(existing ?? ({} as TrackingRecord)),
      ...patch,
      id: recordId,
      walletAddress,
      timestamp: existing?.timestamp ?? Date.now(),
    }

    try {
      if (this.isOnline) {
        const { updateTradingRecord } = await import('@/actions/records')
        await updateTradingRecord(recordId, merged)
      } else {
        this.patchOfflineCache(recordId, merged, walletAddress, chain)
      }
      this.replaceInLocalCache(recordId, merged, walletAddress, chain)
      this.notifySubscribers(walletAddress, chain)
      return merged
    } catch (error) {
      console.error('Failed to update tracking record:', error)
      if (!this.isOnline) {
        this.patchOfflineCache(recordId, merged, walletAddress, chain)
        this.replaceInLocalCache(recordId, merged, walletAddress, chain)
        this.notifySubscribers(walletAddress, chain)
        return merged
      }
      throw error
    }
  }

  // Delete a trading record
  async deleteRecord(id: string, walletAddress: string, chain: 'sol' | 'robinhood' = 'sol'): Promise<void> {
    const key = this.cacheKey(walletAddress, chain)
    try {
      if (this.isOnline) {
        // Try to delete via API first
        await this.deleteViaAPI(id, walletAddress)
      } else {
        // Delete from offline cache
        this.deleteFromOfflineCache(id, walletAddress, chain)
      }

      // Update local cache
      const cached = this.cache.get(key) || []
      const updated = cached.filter(r => r.id !== id)
      this.cache.set(key, updated)

      // Notify subscribers
      this.notifySubscribers(walletAddress, chain)

      console.log(`🗑️ Deleted record: ${id}`)
    } catch (error) {
      console.error('Failed to delete record:', error)
      // Fallback to offline cache on error
      this.deleteFromOfflineCache(id, walletAddress, chain)

      // Update local cache even on error to reflect UI change immediately
      const cached = this.cache.get(key) || []
      const updated = cached.filter(r => r.id !== id)
      this.cache.set(key, updated)
      this.notifySubscribers(walletAddress, chain)
    }
  }

  // Delete record via API
  private async deleteViaAPI(id: string, walletAddress: string): Promise<void> {
    // Client-side: use the Server Action (cookie session, updateTag invalidation).
    // Server-side (cron/bot): fall back to the API route with API_HOST.
    if (typeof window !== 'undefined') {
      const { deleteTradingRecord } = await import('@/actions/records')
      await deleteTradingRecord(id, walletAddress)
      return
    }

    // Use relative URL for client-side, absolute for server-side
    const baseUrl = typeof window !== 'undefined'
      ? ''
      : ((typeof process !== 'undefined' ? (process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST) : undefined) || 'http://localhost:3000');

    const response = await fetch(`${baseUrl}/api/trading/records?id=${id}&wallet=${walletAddress}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`API delete failed: ${error.error || 'Unknown error'}`);
    }
  }

  // Delete from offline cache (localStorage)
  private deleteFromOfflineCache(id: string, walletAddress: string, chain: 'sol' | 'robinhood' = 'sol'): void {
    // Only run in browser environment
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return
    }

    try {
      const key = this.offlineKey(walletAddress, chain)
      const cached = localStorage.getItem(key)
      if (!cached) return

      const records: TrackingRecord[] = JSON.parse(cached)
      const updated = records.filter(r => r.id !== id)

      localStorage.setItem(key, JSON.stringify(updated))
      console.log('💾 Removed from offline cache:', id)
    } catch (error) {
      console.error('Failed to remove from offline cache:', error)
    }
  }

  // Save record via API
  private async saveViaAPI(record: TrackingRecord): Promise<void> {
    // Client-side: use the Server Action (cookie session, updateTag invalidation).
    // Server-side (cron/bot): fall back to the API route with API_HOST.
    if (typeof window !== 'undefined') {
      const { addTradingRecord } = await import('@/actions/records')
      await addTradingRecord(record)
      return
    }

    // Use relative URL for client-side, absolute for server-side
    const baseUrl = typeof window !== 'undefined'
      ? ''
      : ((typeof process !== 'undefined' ? (process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST) : undefined) || 'http://localhost:3000');

    const response = await fetch(`${baseUrl}/api/trading/records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
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
      const key = this.offlineKey(record.walletAddress, record.chain ?? 'sol')
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
  private updateLocalCache(walletAddress: string, records: TrackingRecord[], chain: 'sol' | 'robinhood' = 'sol'): void {
    const key = this.cacheKey(walletAddress, chain)
    const cached = this.cache.get(key) || []

    // If we're adding new records, prepend them
    if (records.length > 0) {
      cached.unshift(...records)
    }

    // Limit cache to 500 records per wallet
    if (cached.length > 500) {
      cached.splice(500)
    }

    this.cache.set(key, cached)
  }

  // Replace a single cached record (used by updateRecord so the history feed
  // reflects a pending swap promoted to confirmed/failed without a refetch).
  private replaceInLocalCache(
    recordId: string,
    record: TrackingRecord,
    walletAddress: string,
    chain: 'sol' | 'robinhood' = 'sol',
  ): void {
    const key = this.cacheKey(walletAddress, chain)
    const cached = this.cache.get(key) || []
    const idx = cached.findIndex((r) => r.id === recordId)
    if (idx >= 0) cached[idx] = record
    else cached.unshift(record)
    this.cache.set(key, cached)
  }

  // Patch the offline localStorage array for a record (mirrors saveToOfflineCache).
  private patchOfflineCache(
    recordId: string,
    record: TrackingRecord,
    walletAddress: string,
    chain: 'sol' | 'robinhood' = 'sol',
  ): void {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return
    }
    try {
      const key = this.offlineKey(walletAddress, chain)
      const cached = localStorage.getItem(key)
      const records: TrackingRecord[] = cached ? JSON.parse(cached) : []
      const idx = records.findIndex((r) => r.id === recordId)
      if (idx >= 0) records[idx] = record
      else records.unshift(record)
      if (records.length > 100) records.splice(100)
      localStorage.setItem(key, JSON.stringify(records))
    } catch (error) {
      console.error('Failed to patch offline record:', error)
    }
  }

  // Get records for specific wallet (with caching)
  async getWalletRecords(
    walletAddress: string,
    useCache: boolean = true,
    chain: 'sol' | 'robinhood' = 'sol',
  ): Promise<TrackingRecord[]> {
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
    if (useCache && this.cache.has(this.cacheKey(walletAddress, chain))) {
      console.log('📦 Returning cached data for wallet:', walletAddress.substring(0, 8) + '...');
      return this.cache.get(this.cacheKey(walletAddress, chain)) || []
    }

    try {
      // Include offline records in the query (only in browser)
      let offlineRecords: TrackingRecord[] = []
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const offlineKey = this.offlineKey(walletAddress, chain)
        offlineRecords = localStorage.getItem(offlineKey)
          ? JSON.parse(localStorage.getItem(offlineKey) || '[]')
          : []
      }

      if (!this.isOnline) {
        // Return only offline records when offline
        this.cache.set(this.cacheKey(walletAddress, chain), offlineRecords)
        return offlineRecords
      }

      // Skip fetch in server-side contexts to prevent URL errors
      if (typeof window === 'undefined') {
        console.log('⚠️ Skipping fetch in server-side context, returning offline/cached data');
        this.cache.set(this.cacheKey(walletAddress, chain), offlineRecords)
        return offlineRecords
      }

      // Fetch from API (client-side only)
      console.log('🌐 Making client-side fetch for wallet records');

      // Use relative URL for client-side, absolute for server-side
      const baseUrl = typeof window !== 'undefined'
        ? ''
        : ((typeof process !== 'undefined' ? (process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST) : undefined) || 'http://localhost:3000');

      const apiUrl = `${baseUrl}/api/trading/records?wallet=${encodeURIComponent(walletAddress)}&limit=500&chain=${encodeURIComponent(chain)}`
      const response = await fetch(apiUrl, { credentials: 'include' })

      if (response.status === 401 || response.status === 403) {
        throw new Error('WALLET_SESSION_REQUIRED')
      }

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
      this.cache.set(this.cacheKey(walletAddress, chain), deduped)

      return deduped
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'WALLET_SESSION_REQUIRED'
      ) {
        throw error
      }

      console.error('Error fetching wallet records:', error)

      let offlineRecords: TrackingRecord[] = []
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const offlineKey = this.offlineKey(walletAddress, chain)
        offlineRecords = localStorage.getItem(offlineKey)
          ? JSON.parse(localStorage.getItem(offlineKey) || '[]')
          : []
      }

      const cached = this.cache.get(this.cacheKey(walletAddress, chain)) || []
      const fallback = [...offlineRecords, ...cached].filter(
        (record, index, self) =>
          self.findIndex((r) => r.id === record.id) === index,
      )
      if (fallback.length > 0) {
        return fallback.sort((a, b) => b.timestamp - a.timestamp)
      }

      throw error
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

      // Use relative URL for client-side, absolute for server-side
      const baseUrl = typeof window !== 'undefined'
        ? ''
        : ((typeof process !== 'undefined' ? (process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST) : undefined) || 'http://localhost:3000');

      const apiUrl = `${baseUrl}/api/trading/records/all?limit=1000`

      const response = await fetch(apiUrl, { credentials: 'include' })

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
   * Check browser limits for connection management
   */
  private checkBrowserLimits(): void {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return

    const maxConnections = navigator.hardwareConcurrency || 4
    console.log(`🌐 Browser info:`, {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      connection: (navigator as any).connection?.effectiveType,
      onLine: navigator.onLine,
      estimatedMaxConnections: maxConnections * 6 // Typical browser limit
    })
  }

  /**
   * Check network connectivity before attempting connections
   */
  private async checkNetworkConnectivity(): Promise<boolean> {
    try {
      const baseUrl = typeof window !== 'undefined'
        ? ''
        : (this.API_HOST || '');

      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'HEAD',
        cache: 'no-cache'
      })
      const isHealthy = response.ok
      console.log(`🌐 Network connectivity check: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'} (${response.status})`)
      return isHealthy
    } catch (error) {
      console.error('🌐 Network connectivity check failed:', error)
      return false
    }
  }

  /**
   * Set up Server-Sent Events connection for real-time updates
   */
  private async setupSSEConnection(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol') {
    if (typeof window === 'undefined') return

    // ✅ NEW: Prevent duplicate connections for same wallet
    if (this.currentWallet === walletAddress &&
      (this.connectionState === 'connected' || this.connectionState === 'connecting')) {
      console.log('SSE connection already exists for wallet:', walletAddress.slice(0, 8) + '...')
      return
    }

    // ✅ NEW: Debounce connection attempts
    const now = Date.now()
    if (now - this.lastConnectionAttempt < this.CONNECTION_DEBOUNCE_MS) {
      console.log('SSE connection debounced, waiting...')
      if (this.connectionDebounceTimeout) {
        clearTimeout(this.connectionDebounceTimeout)
      }
      this.connectionDebounceTimeout = setTimeout(() => {
        this.setupSSEConnection(walletAddress, chain)
      }, this.CONNECTION_DEBOUNCE_MS)
      return
    }

    this.lastConnectionAttempt = now

    // Check network connectivity first
    const isConnected = await this.checkNetworkConnectivity()
    if (!isConnected) {
      console.warn('🌐 Network connectivity issues detected, falling back to polling')
      this.startPolling(walletAddress, chain)
      return
    }

    // Add comprehensive connection attempt logging
    const connectionAttemptId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    console.log(`🔄 [${connectionAttemptId}] Starting SSE connection attempt for wallet: ${walletAddress.slice(0, 8)}...`)
    console.log(`🔄 [${connectionAttemptId}] Connection state: ${this.connectionState}, Reconnect attempts: ${this.reconnectAttempts}`)

    try {
      // Clean up any existing connection first
      this.cleanupSSEConnection()

      // ✅ NEW: Set connection state
      this.setConnectionState('connecting')
      this.currentWallet = walletAddress

      // Use relative URL for client-side connections to ensure we connect to the same domain
      // and avoid CORS issues
      const sseUrl = `/api/trading/subscribe?wallet=${walletAddress}`

      console.log(`🔄 [${connectionAttemptId}] Connecting to: ${sseUrl}`)

      this.sseConnection = new EventSource(sseUrl)
      console.log(`🔄 [${connectionAttemptId}] EventSource created, readyState: ${this.sseConnection.readyState}`)

      // Add connection timeout with more aggressive cleanup
      const connectionTimeout = setTimeout(() => {
        if (this.connectionState === 'connecting') {
          console.warn(`⏰ [${connectionAttemptId}] SSE connection timeout, cleaning up and falling back to polling`)
          this.setConnectionState('disconnected')
          this.cleanupSSEConnection()
          this.startPolling(walletAddress, chain)
        }
      }, 15000) // 15 second timeout

      this.sseConnection.onopen = () => {
        console.log(`📡 [${connectionAttemptId}] SSE connection established successfully`)
        this.setConnectionState('connected')
        this.reconnectAttempts = 0
        clearTimeout(connectionTimeout)
      }

      this.sseConnection.onmessage = (event) => {
        this.lastMessageTime = Date.now() // Track message timing

        try {
          const data = JSON.parse(event.data)

          switch (data.type) {
            case 'connected':
              console.log(`✅ [${connectionAttemptId}] SSE connected for wallet:`, data.wallet?.slice(0, 8) + '...', 'Connection ID:', data.connectionId)
              this.setConnectionState('connected')
              // Start health check monitoring
              this.setupConnectionHealthCheck(connectionAttemptId, walletAddress, chain)
              break

            case 'trade_update':
            case 'pnl_update':
            case 'balance_update':
              console.log(`🔄 [${connectionAttemptId}] Received trading update, refreshing data...`)
              this.handleRealTimeUpdate(walletAddress, chain)
              break

            case 'keepalive':
              // ✅ NEW: Only log keepalive in debug mode to reduce noise
              if (process.env.NODE_ENV === 'development') {
                console.log(`💓 [${connectionAttemptId}] SSE keepalive received`)
              }
              break

            default:
              console.log(`📨 [${connectionAttemptId}] SSE message:`, data)
          }
        } catch (error) {
          console.error(`❌ [${connectionAttemptId}] Error parsing SSE message:`, error, 'Raw data:', event.data)
        }
      }

      this.sseConnection.onerror = (error) => {
        clearTimeout(connectionTimeout)

        // Prevent aggressive error logging if connection is actually open (transient network issues)
        if (this.sseConnection) {
          const readyState = this.sseConnection.readyState

          if (readyState === EventSource.OPEN) {
            // Just warn for OPEN state errors, don't spam console.error
            console.warn(`⚠️ [${connectionAttemptId}] SSE transient error (readyState=OPEN). Connection kept alive, monitoring health...`);
            return;
          }

          // For real errors (Closed/Connecting), log fully
          console.error(`❌ [${connectionAttemptId}] SSE connection error:`, error)
          console.log(`❌ [${connectionAttemptId}] Error details:`, {
            readyState,
            readyStateText: { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSED' }[readyState],
            connectionState: this.connectionState,
            reconnectAttempts: this.reconnectAttempts,
            timestamp: new Date().toISOString(),
            url: sseUrl
          })

          // Handle reconnection logic
          if (readyState === EventSource.CLOSED) {
            console.warn(`❌ [${connectionAttemptId}] SSE connection was closed, attempting reconnection`)
            this.setConnectionState('disconnected')
            this.handleSSEReconnect(walletAddress, chain)
          } else if (readyState === EventSource.CONNECTING && this.connectionState === 'connecting') {
            console.warn(`❌ [${connectionAttemptId}] SSE connection failed during connection attempt`)
            this.setConnectionState('disconnected')
            this.cleanupSSEConnection()
            this.handleSSEReconnect(walletAddress, chain)
          }
        } else {
          // Fallback if sseConnection is somehow null but onerror fired
          console.error(`❌ [${connectionAttemptId}] SSE connection error (instance null):`, error)
          this.setConnectionState('disconnected')
          this.handleSSEReconnect(walletAddress, chain)
        }
      }

    } catch (error) {
      console.error(`❌ [${connectionAttemptId}] Failed to establish SSE connection:`, error)
      console.log(`❌ [${connectionAttemptId}] Setup failure details:`, {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        connectionState: this.connectionState,
        timestamp: new Date().toISOString()
      })
      this.setConnectionState('disconnected')
      // Fall back to polling immediately on setup failure
      this.startPolling(walletAddress)
    }
  }

  /**
   * Handle SSE reconnection with exponential backoff
   */
  private handleSSEReconnect(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol') {
    // ✅ NEW: Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    // Clean up current connection first
    this.cleanupSSEConnection()

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('Max SSE reconnection attempts reached, falling back to polling only')
      this.setConnectionState('disconnected')
      this.startPolling(walletAddress, chain)
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    this.setConnectionState('reconnecting')

    console.log(`Reconnecting SSE in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      // Check if we should still attempt reconnection
      if (this.subscribers.has(walletAddress) && this.subscribers.get(walletAddress)!.size > 0) {
        this.setupSSEConnection(walletAddress, chain)
      } else {
        console.log('No active subscribers, skipping SSE reconnection')
        this.setConnectionState('disconnected')
      }
    }, delay)
  }

  /**
   * Set up connection health check monitoring
   */
  private setupConnectionHealthCheck(connectionAttemptId: string, walletAddress: string, chain: 'sol' | 'robinhood' = 'sol'): void {
    // Clear any existing health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
    }

    this.healthCheckInterval = setInterval(() => {
      if (this.sseConnection && this.connectionState === 'connected') {
        // Check if we've received any messages recently
        const now = Date.now()
        const timeSinceLastMessage = now - (this.lastMessageTime || now)

        // If no messages for 60 seconds, consider connection stale
        if (timeSinceLastMessage > 60000) {
          console.warn(`⚠️ [${connectionAttemptId}] No SSE messages for ${Math.round(timeSinceLastMessage / 1000)}s, checking connection health`)

          // Force reconnect if timeout reached, regardless of readyState (unless intentionally disconnected)
          console.warn(`⚠️ [${connectionAttemptId}] Connection health check failed (timeout), reconnecting...`)
          this.setConnectionState('disconnected')
          this.cleanupSSEConnection()
          this.handleSSEReconnect(walletAddress, chain)
        }
      }
    }, 30000) // Check every 30 seconds
  }

  /**
   * Clean up SSE connection
   */
  private cleanupSSEConnection() {
    if (this.sseConnection) {
      console.log('🧹 Cleaning up SSE connection')

      // Remove event listeners to prevent memory leaks
      this.sseConnection.onopen = null
      this.sseConnection.onmessage = null
      this.sseConnection.onerror = null

      // Close the connection
      this.sseConnection.close()
      this.sseConnection = null
    }

    // ✅ NEW: Clean up timeouts and reset state
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.connectionDebounceTimeout) {
      clearTimeout(this.connectionDebounceTimeout)
      this.connectionDebounceTimeout = null
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }

    this.setConnectionState('disconnected')
    this.currentWallet = null
  }

  /**
   * Start polling as fallback when SSE fails
   */
  private startPolling(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol') {
    // Prevent multiple polling intervals
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
    }

    console.log('🔄 Starting polling fallback for wallet updates')

    this.pollingInterval = setInterval(async () => {
      try {
        // Only poll if we still have active subscribers for this wallet
        if (this.subscribers.has(walletAddress) && this.subscribers.get(walletAddress)!.size > 0) {
          const records = await this.getWalletRecords(walletAddress, false, chain) // Force fresh data
          this.updateLocalCache(walletAddress, records, chain)
          this.notifySubscribers(walletAddress)
        } else {
          // No active subscribers, stop polling
          console.log('No active subscribers, stopping polling')
          this.stopPolling()
        }
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, 8000) // Poll every 8 seconds
  }

  /**
   * Stop polling
   */
  private stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
      console.log('🛑 Stopped polling')
    }
  }

  /**
   * Subscribe to real-time wallet updates using SSE with polling fallback
   */
  subscribeToWallet(walletAddress: string, callback: (records: TrackingRecord[]) => void, chain: 'sol' | 'robinhood' = 'sol'): () => void {
    console.log(`🔔 Setting up real-time subscription for wallet: ${walletAddress.slice(0, 8)}...`)

    // Add callback to subscribers
    if (!this.subscribers.has(walletAddress)) {
      this.subscribers.set(walletAddress, new Set())
    }
    this.subscribers.get(walletAddress)!.add(callback)

    // Immediately emit cached data (chain-scoped so switching networks never
    // shows the other chain's records)
    const cachedRecords = this.cache.get(this.cacheKey(walletAddress, chain)) || []
    callback(cachedRecords)

    // ✅ NEW: Only setup connection if not already connected to this wallet
    if (this.currentWallet !== walletAddress || this.connectionState === 'disconnected') {
      this.setupSSEConnection(walletAddress, chain)
    }

    // Return unsubscribe function
    return () => {
      const walletSubscribers = this.subscribers.get(walletAddress)
      if (walletSubscribers) {
        walletSubscribers.delete(callback)

        // Clean up if no more subscribers
        if (walletSubscribers.size === 0) {
          this.subscribers.delete(walletAddress)

          // ✅ NEW: Only cleanup if this was the current wallet
          if (this.currentWallet === walletAddress) {
            this.cleanupSSEConnection()
          }

          // Stop polling if no subscribers
          if (this.pollingInterval && this.subscribers.size === 0) {
            clearInterval(this.pollingInterval)
            this.pollingInterval = null
          }
        }
      }
    }
  }

  /**
   * Handle real-time update by refreshing data
   */
  private async handleRealTimeUpdate(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol') {
    try {
      const records = await this.getWalletRecords(walletAddress, false, chain)
      this.updateLocalCache(walletAddress, records, chain)
      this.notifySubscribers(walletAddress)
    } catch (error) {
      console.error('Error handling real-time update:', error)
    }
  }

  // ✅ NEW: Helper method specifically for Jupiter Terminal swaps
  async trackJupiterSwap(params: {
    walletAddress: string
    operationType: 'buy' | 'sell'
    inputMint: string
    outputMint: string
    inputAmount: number
    outputAmount: number
    inputDecimals: number
    outputDecimals: number
    inputSymbol?: string
    outputSymbol?: string
    inputName?: string
    outputName?: string
    inputLogoURI?: string
    outputLogoURI?: string
    txid: string
    feeAmount?: number
    slippageBps?: number
    solPriceUsd: number
    quoteResponse?: any
    chain?: 'sol' | 'robinhood'
  }): Promise<void> {
    try {
      const {
        walletAddress,
        operationType,
        inputMint,
        outputMint,
        inputAmount,
        outputAmount,
        inputDecimals,
        outputDecimals,
        inputSymbol,
        outputSymbol,
        inputName,
        outputName,
        inputLogoURI,
        outputLogoURI,
        txid,
        feeAmount = 0,
        slippageBps,
        solPriceUsd,
        quoteResponse
      } = params

      const SOL_MINT = 'So11111111111111111111111111111111111111112'

      // Convert amounts from raw to UI amounts
      const inputUIAmount = inputAmount / Math.pow(10, inputDecimals)
      const outputUIAmount = outputAmount / Math.pow(10, outputDecimals)

      let tokenInfo: any
      let solAmount: number

      if (operationType === 'buy') {
        // SOL -> Token
        solAmount = inputUIAmount // SOL spent
        tokenInfo = {
          mintAddress: outputMint,
          symbol: outputSymbol,
          name: outputName,
          logoURI: outputLogoURI,
          tokenAmount: outputUIAmount,
          solAmount,
          priceUsd: outputUIAmount > 0 ? (solAmount * solPriceUsd) / outputUIAmount : 0,
          solPrice: solPriceUsd
        }
      } else {
        // Token -> SOL
        solAmount = outputUIAmount // SOL received
        tokenInfo = {
          mintAddress: inputMint,
          symbol: inputSymbol,
          name: inputName,
          logoURI: inputLogoURI,
          tokenAmount: inputUIAmount,
          solAmount,
          priceUsd: inputUIAmount > 0 ? (solAmount * solPriceUsd) / inputUIAmount : 0,
          solPrice: solPriceUsd
        }
      }

      // Create tracking record
      const record: Omit<TrackingRecord, 'id' | 'timestamp'> = {
        walletAddress,
        operationType,
        tokens: [tokenInfo],
        successCount: 1,
        failureCount: 0,
        totalTokens: 1,
        solAmount,
        feesPaid: feeAmount / Math.pow(10, 9), // Convert from lamports
        solPriceUsd,
        totalUsdValue: solAmount * solPriceUsd,
        signatures: [txid],
        slippage: slippageBps ? slippageBps / 100 : undefined,
        is_bot_operation: false, // Jupiter Terminal swaps are manual
        jupiter_swap: true,
        swap_route: quoteResponse?.routePlan ? JSON.stringify(quoteResponse.routePlan) : undefined,
        chain: params.chain ?? 'sol'
      }

      await this.trackOperation(record)

      console.log(`🎯 Jupiter ${operationType} tracked:`, {
        token: tokenInfo.symbol || tokenInfo.name || 'Unknown',
        amount: tokenInfo.tokenAmount,
        solAmount,
        txid: txid.slice(0, 8) + '...'
      })

    } catch (error) {
      console.error('Failed to track Jupiter swap:', error)
      throw error
    }
  }

  // Notify subscribers of changes
  private notifySubscribers(walletAddress: string, chain: 'sol' | 'robinhood' = 'sol'): void {
    const walletSubscribers = this.subscribers.get(walletAddress)
    if (walletSubscribers) {
      const records = this.cache.get(this.cacheKey(walletAddress, chain)) || []
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
  solPriceUsd?: number,
  chain: 'sol' | 'robinhood' = 'sol'
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
    errors,
    chain
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
  solPriceUsd?: number,
  chain: 'sol' | 'robinhood' = 'sol'
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
    errors,
    chain
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
  solPriceUsd?: number,
  chain: 'sol' | 'robinhood' = 'sol'
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
    errors,
    chain
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