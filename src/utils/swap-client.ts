// Health check cache to avoid repeated health checks
let workerHealthStatus: { isHealthy: boolean; lastCheck: number } | null = null
const HEALTH_CHECK_CACHE_DURATION = 30000 // 30 seconds

// Check if Cloudflare Worker is healthy
async function checkWorkerHealth(workerUrl: string): Promise<boolean> {
  // Return cached result if recent
  if (workerHealthStatus && Date.now() - workerHealthStatus.lastCheck < HEALTH_CHECK_CACHE_DURATION) {
    return workerHealthStatus.isHealthy
  }

  try {
    const response = await fetch(workerUrl, {
      method: 'OPTIONS', // Use OPTIONS for health check
      headers: {
        'Accept': 'application/json',
      },
    })
    
    const isHealthy = response.ok
    workerHealthStatus = {
      isHealthy,
      lastCheck: Date.now()
    }
    
    return isHealthy
  } catch (error) {
    console.warn('Worker health check failed:', error)
    workerHealthStatus = {
      isHealthy: false,
      lastCheck: Date.now()
    }
    return false
  }
}

// Client for communicating with our Cloudflare Worker swap service
export async function fetchSwapTxn(params: {
  direction: 'buy' | 'sell'
  mint: string
  amount: number       // SOL units (e.g. 0.02)
  slippage: number     // 0.5 means 0.5 %
  payer: string
  priorityFee: number  // SOL units
}) {
  // Use Cloudflare Worker URL in production, fallback to SolanaTracker for development
  const swapBase = process.env.NEXT_PUBLIC_SWAP_WORKER_URL || 'https://swap-worker.intrasection.workers.dev'
  
  // Skip worker if we know it's unhealthy (but still try occasionally)
  const shouldTryWorker = !workerHealthStatus || workerHealthStatus.isHealthy || Math.random() < 0.1 // 10% chance to retry unhealthy worker
  
  if (shouldTryWorker) {
    try {
      const res = await fetch(swapBase, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(params),
        // Add timeout to prevent hanging
        signal: AbortSignal.timeout(10000) // 10 second timeout
      })
      
      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`Swap Worker ${res.status}: ${errorText}`)
      }
      
      const result = await res.json()
      
      if (result.error) {
        throw new Error(`Swap Worker Error: ${result.error}`)
      }
      
      if (!result.txn) {
        throw new Error('No transaction returned from swap worker')
      }
      
      // Mark worker as healthy on successful request
      workerHealthStatus = {
        isHealthy: true,
        lastCheck: Date.now()
      }
      
      console.log('✅ Successfully used Cloudflare Worker for swap')
      return result.txn as string
      
    } catch (error) {
      console.warn('⚠️ Cloudflare Worker failed, falling back to direct SolanaTracker:', error instanceof Error ? error.message : error)
      
      // Mark worker as unhealthy
      workerHealthStatus = {
        isHealthy: false,
        lastCheck: Date.now()
      }
      
      // Automatic fallback to direct SolanaTracker API
      try {
        const fallbackResult = await fetchSwapTxnDirect(params)
        console.log('✅ Successfully used SolanaTracker fallback')
        return fallbackResult
      } catch (fallbackError) {
        console.error('❌ Both Worker and SolanaTracker failed:', fallbackError)
        throw new Error(`Both swap services failed. Worker: ${error instanceof Error ? error.message : error}. SolanaTracker: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`)
      }
    }
  } else {
    console.log('⚠️ Skipping unhealthy Cloudflare Worker, using SolanaTracker directly')
    
    try {
      const fallbackResult = await fetchSwapTxnDirect(params)
      console.log('✅ Successfully used SolanaTracker direct')
      return fallbackResult
    } catch (fallbackError) {
      console.error('❌ SolanaTracker failed:', fallbackError)
      throw new Error(`SolanaTracker failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`)
    }
  }
}

// Fallback function that uses SolanaTracker directly (for development or backup)
export async function fetchSwapTxnDirect(params: {
  direction: 'buy' | 'sell'
  mint: string
  amount: number       // SOL units (e.g. 0.02)
  slippage: number     // 0.5 means 0.5 %
  payer: string
  priorityFee: number  // SOL units
}) {
  const apiBody = {
    from: params.direction === 'buy' ? 'So11111111111111111111111111111111111111112' : params.mint,
    to: params.direction === 'buy' ? params.mint : 'So11111111111111111111111111111111111111112',
    amount: params.amount,
    slippage: params.slippage,
    payer: params.payer,
    priorityFee: params.priorityFee,
    fee: "3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX:0.5"
  }
  
  const res = await fetch('https://swap-v2.solanatracker.io/swap', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Connection': 'keep-alive'
    },
    body: JSON.stringify(apiBody)
  })
  
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`SolanaTracker ${res.status}: ${errorText}`)
  }
  
  const result = await res.json()
  
  if (!result.txn) {
    throw new Error('No transaction returned from SolanaTracker')
  }
  
  return result.txn as string
}

// Utility function to manually check worker health (for debugging)
export async function checkSwapWorkerHealth(): Promise<{ isHealthy: boolean; workerUrl: string; error?: string }> {
  const workerUrl = process.env.NEXT_PUBLIC_SWAP_WORKER_URL || 'https://swap-worker.intrasection.workers.dev'
  
  try {
    const isHealthy = await checkWorkerHealth(workerUrl)
    return {
      isHealthy,
      workerUrl,
      error: isHealthy ? undefined : 'Worker health check failed'
    }
  } catch (error) {
    return {
      isHealthy: false,
      workerUrl,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
} 