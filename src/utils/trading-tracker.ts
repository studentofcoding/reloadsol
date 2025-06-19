// Trading Operations Tracker
// Simple cache-based tracking using localStorage

export interface TrackingRecord {
  id: string
  walletAddress: string
  operationType: 'buy' | 'sell' | 'close'
  timestamp: number
  
  // Token information
  tokens: Array<{
    mintAddress: string
    symbol?: string
    name?: string
    logoURI?: string
  }>
  
  // Operation results
  successCount: number
  failureCount: number
  totalTokens: number
  
  // Financial data
  solAmount?: number // For buys: amount spent, For sells: amount received
  feesPaid: number
  
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
  private readonly STORAGE_KEY = 'bulk_trading_records'
  private readonly MAX_RECORDS = 1000 // Prevent localStorage bloat

  // Add a new tracking record
  trackOperation(record: Omit<TrackingRecord, 'id' | 'timestamp'>): void {
    try {
      const records = this.getAllRecords()
      
      const newRecord: TrackingRecord = {
        ...record,
        id: this.generateId(),
        timestamp: Date.now()
      }
      
      // Add to beginning of array (most recent first)
      records.unshift(newRecord)
      
      // Trim to max records to prevent storage bloat
      if (records.length > this.MAX_RECORDS) {
        records.splice(this.MAX_RECORDS)
      }
      
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(records))
      
      console.log(`📊 Tracked ${record.operationType} operation:`, {
        wallet: record.walletAddress.slice(0, 8) + '...',
        tokens: record.totalTokens,
        success: record.successCount,
        failed: record.failureCount
      })
    } catch (error) {
      console.error('Failed to track operation:', error)
    }
  }

  // Get all tracking records
  getAllRecords(): TrackingRecord[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY)
      return stored ? JSON.parse(stored) : []
    } catch (error) {
      console.error('Failed to retrieve tracking records:', error)
      return []
    }
  }

  // Get records for specific wallet
  getWalletRecords(walletAddress: string): TrackingRecord[] {
    return this.getAllRecords().filter(record => 
      record.walletAddress === walletAddress
    )
  }

  // Get records by operation type
  getOperationRecords(operationType: 'buy' | 'sell' | 'close'): TrackingRecord[] {
    return this.getAllRecords().filter(record => 
      record.operationType === operationType
    )
  }

  // Get records within date range
  getRecordsInRange(startDate: Date, endDate: Date): TrackingRecord[] {
    const start = startDate.getTime()
    const end = endDate.getTime()
    
    return this.getAllRecords().filter(record => 
      record.timestamp >= start && record.timestamp <= end
    )
  }

  // Get recent records (last N records)
  getRecentRecords(count: number = 10): TrackingRecord[] {
    return this.getAllRecords().slice(0, count)
  }

  // Calculate aggregate statistics
  getStats(walletAddress?: string): TrackingStats {
    const records = walletAddress 
      ? this.getWalletRecords(walletAddress)
      : this.getAllRecords()

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
    let totalAttempted = 0

    records.forEach(record => {
      // Count by operation type
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
      totalAttempted += record.totalTokens
    })

    stats.successRate = totalAttempted > 0 ? (totalSuccessful / totalAttempted) * 100 : 0

    return stats
  }

  // Clear all records (useful for testing or user preference)
  clearAllRecords(): void {
    localStorage.removeItem(this.STORAGE_KEY)
    console.log('🧹 Cleared all tracking records')
  }

  // Clear old records (older than specified days)
  clearOldRecords(daysOld: number = 30): number {
    const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000)
    const records = this.getAllRecords()
    const filtered = records.filter(record => record.timestamp >= cutoffTime)
    
    const removedCount = records.length - filtered.length
    
    if (removedCount > 0) {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filtered))
      console.log(`🧹 Cleared ${removedCount} old records (older than ${daysOld} days)`)
    }
    
    return removedCount
  }

  // Export records as JSON (for backup/analysis)
  exportRecords(): string {
    return JSON.stringify(this.getAllRecords(), null, 2)
  }

  // Import records from JSON (for restore)
  importRecords(jsonData: string): boolean {
    try {
      const importedRecords = JSON.parse(jsonData) as TrackingRecord[]
      
      // Validate the structure
      if (!Array.isArray(importedRecords)) {
        throw new Error('Invalid data format')
      }

      // Basic validation of record structure
      for (const record of importedRecords) {
        if (!record.id || !record.walletAddress || !record.operationType || !record.timestamp) {
          throw new Error('Invalid record structure')
        }
      }

      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(importedRecords))
      console.log(`📥 Imported ${importedRecords.length} tracking records`)
      return true
    } catch (error) {
      console.error('Failed to import records:', error)
      return false
    }
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

// Create singleton instance
export const tradingTracker = new TradingTracker()

// Helper functions for easy integration
export const trackBuyOperation = (
  walletAddress: string,
  tokens: Array<{ mintAddress: string; symbol?: string; name?: string; logoURI?: string }>,
  solAmount: number,
  successCount: number,
  failureCount: number,
  signatures: string[],
  feesPaid: number,
  slippage?: number,
  priorityFee?: number,
  errors?: string[]
) => {
  tradingTracker.trackOperation({
    walletAddress,
    operationType: 'buy',
    tokens,
    totalTokens: tokens.length,
    successCount,
    failureCount,
    solAmount,
    feesPaid,
    signatures,
    slippage,
    priorityFee,
    errors
  })
}

export const trackSellOperation = (
  walletAddress: string,
  tokens: Array<{ mintAddress: string; symbol?: string; name?: string; logoURI?: string }>,
  solReceived: number,
  successCount: number,
  failureCount: number,
  signatures: string[],
  feesPaid: number,
  slippage?: number,
  priorityFee?: number,
  errors?: string[]
) => {
  tradingTracker.trackOperation({
    walletAddress,
    operationType: 'sell',
    tokens,
    totalTokens: tokens.length,
    successCount,
    failureCount,
    solAmount: solReceived,
    feesPaid,
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
  errors?: string[]
) => {
  tradingTracker.trackOperation({
    walletAddress,
    operationType: 'close',
    tokens,
    totalTokens: tokens.length,
    successCount,
    failureCount,
    feesPaid,
    signatures,
    errors
  })
} 