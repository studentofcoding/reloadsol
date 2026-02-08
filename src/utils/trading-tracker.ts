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
  private cache: Map<string, TrackingRecord[]> = new Map() // Per-wallet cache
  private isOnline: boolean = true
  private sseConnection: EventSource | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private readonly API_HOST = process.env.API_HOST;

  // ✅ NEW: Connection state management
  private connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected'
  private currentWallet: string | null = null
  private reconnectTimeout: NodeJS.Timeout | null = null
  private connectionDebounceTimeout: NodeJS.Timeout | null = null
  private lastConnectionAttempt = 0
  private readonly CONNECTION_DEBOUNCE_MS = 1000 // Prevent rapid reconnections
  private lastMessageTime: number = 0
  private healthCheckInterval: NodeJS.Timeout | null = null

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

  // Delete a trading record
  async deleteRecord(id: string, walletAddress: string): Promise<void> {
    try {
      if (this.isOnline) {
        // Try to delete via API first
        await this.deleteViaAPI(id, walletAddress)
      } else {
        // Delete from offline cache
        this.deleteFromOfflineCache(id, walletAddress)
      }

      // Update local cache
      const cached = this.cache.get(walletAddress) || []
      const updated = cached.filter(r => r.id !== id)
      this.cache.set(walletAddress, updated)

      // Notify subscribers
      this.notifySubscribers(walletAddress)

      console.log(`🗑️ Deleted record: ${id}`)
    } catch (error) {
      console.error('Failed to delete record:', error)
      // Fallback to offline cache on error
      this.deleteFromOfflineCache(id, walletAddress)

      // Update local cache even on error to reflect UI change immediately
      const cached = this.cache.get(walletAddress) || []
      const updated = cached.filter(r => r.id !== id)
      this.cache.set(walletAddress, updated)
      this.notifySubscribers(walletAddress)
    }
  }

  // Delete record via API
  private async deleteViaAPI(id: string, walletAddress: string): Promise<void> {
    // Use absolute URL for server-side compatibility
    const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
    const response = await fetch(`${baseUrl}/api/trading/records?id=${id}&wallet=${walletAddress}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`API delete failed: ${error.error || 'Unknown error'}`);
    }
  }

  // Delete from offline cache (localStorage)
  private deleteFromOfflineCache(id: string, walletAddress: string): void {
    // Only run in browser environment
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return
    }

    try {
      const key = `offline_trading_${walletAddress}`
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
      const response = await fetch(`${this.API_HOST || ''}/api/health`, {
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
  private async setupSSEConnection(walletAddress: string) {
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
        this.setupSSEConnection(walletAddress)
      }, this.CONNECTION_DEBOUNCE_MS)
      return
    }

    this.lastConnectionAttempt = now

    // Check network connectivity first
    const isConnected = await this.checkNetworkConnectivity()
    if (!isConnected) {
      console.warn('🌐 Network connectivity issues detected, falling back to polling')
      this.startPolling(walletAddress)
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
      this.connectionState = 'connecting'
      this.currentWallet = walletAddress

      // Use window.location.origin for client-side connections to ensure we connect to the same domain
      const baseUrl = typeof window !== 'undefined'
        ? window.location.origin
        : (process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000')

      const sseUrl = `${baseUrl}/api/trading/subscribe?wallet=${walletAddress}`

      console.log(`🔄 [${connectionAttemptId}] Connecting to: ${sseUrl}`)

      this.sseConnection = new EventSource(sseUrl)
      console.log(`🔄 [${connectionAttemptId}] EventSource created, readyState: ${this.sseConnection.readyState}`)

      // Add connection timeout with more aggressive cleanup
      const connectionTimeout = setTimeout(() => {
        if (this.connectionState === 'connecting') {
          console.warn(`⏰ [${connectionAttemptId}] SSE connection timeout, cleaning up and falling back to polling`)
          this.connectionState = 'disconnected'
          this.cleanupSSEConnection()
          this.startPolling(walletAddress)
        }
      }, 15000) // 15 second timeout

      this.sseConnection.onopen = () => {
        console.log(`📡 [${connectionAttemptId}] SSE connection established successfully`)
        this.connectionState = 'connected'
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
              this.connectionState = 'connected'
              // Start health check monitoring
              this.setupConnectionHealthCheck(connectionAttemptId, walletAddress)
              break

            case 'trade_update':
            case 'pnl_update':
            case 'balance_update':
              console.log(`🔄 [${connectionAttemptId}] Received trading update, refreshing data...`)
              this.handleRealTimeUpdate(walletAddress)
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
        console.error(`❌ [${connectionAttemptId}] SSE connection error:`, error)
        console.log(`❌ [${connectionAttemptId}] Error details:`, {
          readyState: this.sseConnection?.readyState,
          connectionState: this.connectionState,
          reconnectAttempts: this.reconnectAttempts,
          timestamp: new Date().toISOString(),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
          url: sseUrl
        })
        clearTimeout(connectionTimeout)

        // Enhanced error handling based on connection state
        if (this.sseConnection) {
          const readyState = this.sseConnection.readyState
          console.log(`❌ [${connectionAttemptId}] SSE ReadyState:`, readyState, {
            0: 'CONNECTING',
            1: 'OPEN',
            2: 'CLOSED'
          }[readyState])

          // ✅ FIXED: Handle all readyState scenarios
          if (readyState === EventSource.CLOSED) {
            console.warn(`❌ [${connectionAttemptId}] SSE connection was closed, attempting reconnection`)
            this.connectionState = 'disconnected'
            this.handleSSEReconnect(walletAddress)
          } else if (readyState === EventSource.CONNECTING && this.connectionState === 'connecting') {
            console.warn(`❌ [${connectionAttemptId}] SSE connection failed during connection attempt`)
            this.connectionState = 'disconnected'
            this.cleanupSSEConnection()
            this.handleSSEReconnect(walletAddress)
          } else if (readyState === EventSource.OPEN) {
            // ✅ UPDATED: If OPEN, it's likely a transient error or noise. 
            // Don't disconnect immediately - rely on health check to kill it if data stops flowing.
            console.warn(`⚠️ [${connectionAttemptId}] SSE error received but connection is OPEN. Monitoring health...`)
          }
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
      this.connectionState = 'disconnected'
      // Fall back to polling immediately on setup failure
      this.startPolling(walletAddress)
    }
  }

  /**
   * Handle SSE reconnection with exponential backoff
   */
  private handleSSEReconnect(walletAddress: string) {
    // ✅ NEW: Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    // Clean up current connection first
    this.cleanupSSEConnection()

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('Max SSE reconnection attempts reached, falling back to polling only')
      this.connectionState = 'disconnected'
      this.startPolling(walletAddress)
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    this.connectionState = 'reconnecting'

    console.log(`Reconnecting SSE in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      // Check if we should still attempt reconnection
      if (this.subscribers.has(walletAddress) && this.subscribers.get(walletAddress)!.size > 0) {
        this.setupSSEConnection(walletAddress)
      } else {
        console.log('No active subscribers, skipping SSE reconnection')
        this.connectionState = 'disconnected'
      }
    }, delay)
  }

  /**
   * Set up connection health check monitoring
   */
  private setupConnectionHealthCheck(connectionAttemptId: string, walletAddress: string): void {
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
          this.connectionState = 'disconnected'
          this.cleanupSSEConnection()
          this.handleSSEReconnect(walletAddress)
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

    this.connectionState = 'disconnected'
    this.currentWallet = null
  }

  /**
   * Start polling as fallback when SSE fails
   */
  private startPolling(walletAddress: string) {
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
          const records = await this.getWalletRecords(walletAddress, false) // Force fresh data
          this.updateLocalCache(walletAddress, records)
          this.notifySubscribers(walletAddress)
        } else {
          // No active subscribers, stop polling
          console.log('No active subscribers, stopping polling')
          this.stopPolling()
        }
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, 30000) // Poll every 30 seconds
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

    // ✅ NEW: Only setup connection if not already connected to this wallet
    if (this.currentWallet !== walletAddress || this.connectionState === 'disconnected') {
      this.setupSSEConnection(walletAddress)
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
  private async handleRealTimeUpdate(walletAddress: string) {
    try {
      const records = await this.getWalletRecords(walletAddress)
      this.updateLocalCache(walletAddress, records)
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
        swap_route: quoteResponse?.routePlan ? JSON.stringify(quoteResponse.routePlan) : undefined
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