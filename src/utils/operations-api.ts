// Client-side utilities for secure operations tracking

interface TrackOperationRequest {
  walletAddress: string;
  operationType: 'buy' | 'sell' | 'close';
  successCount: number;
  /** Idempotency key — the server applies the operation once and ignores repeats. */
  operationKey?: string;
  failureCount?: number;
  solBalance?: number;
  metadata?: {
    tokenMints?: string[];
    solAmount?: number;
    signatures?: string[];
  };
}

interface TrackOperationResponse {
  success: boolean;
  pointsEarned: number;
  /** false when the server recognised the key as already applied. */
  applied?: boolean;
  duplicate?: boolean;
  operationType: string;
  successCount: number;
  dbOperationType: string;
  message: string;
}

interface WalletStatsResponse {
  points: number;
  tokenCount: number;
  swapCount: number;
  closeCount: number;
  breakdown: {
    swapPoints: number;
    closePoints: number;
  };
}

/**
 * Retry a request that failed for a reason a retry can fix.
 *
 * A deploy landing under an open tab changes chunk filenames, so the browser's lazy chunk load 404s and
 * throws `ChunkLoadError` — the request may never have left the tab. This path used to have no handling
 * at all (`operations-api.ts`), so the operation was simply lost: no row, no points, nothing to
 * reconcile against. The same shape already exists in `jupiter.ts`.
 *
 * Only transport-shaped failures retry. A 4xx/5xx from the server is a real answer and is rethrown.
 */
const RETRYABLE_MESSAGE = /ChunkLoadError|Loading chunk|NetworkError|Failed to fetch|network/i;

async function withTransportRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof Error && RETRYABLE_MESSAGE.test(error.message ?? '');
      if (!retryable || attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

/**
 * Track a successful operation (buy, sell, or close) securely via server route.
 *
 * Generates an idempotency key per call, so the retry above cannot double-count: the server applies the
 * operation once and reports every repeat as a duplicate. The key must be created ONCE per logical
 * operation, outside the retry — a key regenerated per attempt would defeat the whole mechanism.
 */
export async function trackOperation(
  walletAddress: string,
  operationType: 'buy' | 'sell' | 'close',
  successCount: number,
  options?: {
    failureCount?: number;
    solBalance?: number;
    tokenMints?: string[];
    solAmount?: number;
    signatures?: string[];
  }
): Promise<TrackOperationResponse> {
  try {
    const operationKey =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const requestData: TrackOperationRequest = {
      walletAddress,
      operationType,
      successCount,
      operationKey,
      failureCount: options?.failureCount,
      solBalance: options?.solBalance,
      metadata: {
        tokenMints: options?.tokenMints,
        solAmount: options?.solAmount,
        signatures: options?.signatures,
      }
    };

    const response = await withTransportRetry(() =>
      fetch('/api/operations/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData),
      }),
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    const result: TrackOperationResponse = await response.json();
    
    const RENT_PER_CLOSE = 0.00203928;
    if (options?.solAmount && options.solAmount > 0) {
      try {
        await updateSolRecovered(walletAddress, options.solAmount, operationType);
      } catch (error) {
        console.warn('Failed to update SOL recovered, continuing...', error);
      }
    } else if (operationType === 'close' && successCount > 0) {
      try {
        await updateSolRecovered(walletAddress, successCount * RENT_PER_CLOSE, 'close');
      } catch (error) {
        console.warn('Failed to update SOL recovered, continuing...', error);
      }
    }
    
    // Log success for debugging
    console.log(`✅ Operation tracked: ${operationType} - ${successCount} successful - ${result.pointsEarned} points earned`);
    
    return result;
  } catch (error) {
    console.error('❌ Failed to track operation:', error);
    throw error;
  }
}

/**
 * Get wallet points and statistics securely via server route
 */
export async function getWalletPoints(walletAddress: string): Promise<WalletStatsResponse> {
  try {
    const response = await fetch(`/api/operations/points?wallet=${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    const result: WalletStatsResponse = await response.json();
    return result;
  } catch (error) {
    console.error('❌ Failed to fetch wallet points:', error);
    throw error;
  }
}

/**
 * Convenience functions for specific operation types
 */
export const trackBuy = (
  walletAddress: string,
  successCount: number,
  options?: {
    failureCount?: number;
    solBalance?: number;
    solAmount?: number;
    tokenMints?: string[];
    signatures?: string[];
  }
) => trackOperation(walletAddress, 'buy', successCount, options);

export const trackSell = (
  walletAddress: string,
  successCount: number,
  options?: {
    failureCount?: number;
    solBalance?: number;
    solAmount?: number;
    tokenMints?: string[];
    signatures?: string[];
  }
) => trackOperation(walletAddress, 'sell', successCount, options);

export const trackClose = (
  walletAddress: string,
  successCount: number,
  options?: {
    failureCount?: number;
    solBalance?: number;
    solAmount?: number;
    tokenMints?: string[];
    signatures?: string[];
  }
) => trackOperation(walletAddress, 'close', successCount, options);

/**
 * Batch operations tracking (for bulk operations)
 */
export async function trackBulkOperations(operations: Array<{
  walletAddress: string;
  operationType: 'buy' | 'sell' | 'close';
  successCount: number;
  failureCount?: number;
  solBalance?: number;
  metadata?: {
    tokenMints?: string[];
    solAmount?: number;
    signatures?: string[];
  };
}>): Promise<TrackOperationResponse[]> {
  const results = await Promise.allSettled(
    operations.map(op => trackOperation(
      op.walletAddress,
      op.operationType,
      op.successCount,
      {
        failureCount: op.failureCount,
        solBalance: op.solBalance,
        tokenMints: op.metadata?.tokenMints,
        solAmount: op.metadata?.solAmount,
        signatures: op.metadata?.signatures,
      }
    ))
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error(`Failed to track operation ${index}:`, result.reason);
      // Return a default error response
      return {
        success: false,
        pointsEarned: 0,
        operationType: operations[index].operationType,
        successCount: 0,
        dbOperationType: operations[index].operationType === 'close' ? 'close' : 'swap',
        message: `Failed to track ${operations[index].operationType} operation`
      };
    }
  });
}

/**
 * Get multiple wallet stats in batch
 */
export async function getBatchWalletPoints(walletAddresses: string[]): Promise<{
  success: boolean;
  results: Array<{
    walletAddress: string;
    points: number;
    tokenCount: number;
    error: string | null;
  }>;
  count: number;
}> {
  try {
    const response = await fetch('/api/operations/points', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ walletAddresses }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('❌ Failed to fetch batch wallet points:', error);
    throw error;
  }
}

/**
 * Update total SOL recovered for a wallet
 */
export async function updateSolRecovered(
  walletAddress: string,
  solRecovered: number,
  operationType: 'buy' | 'sell' | 'close'
): Promise<void> {
  try {
    const response = await fetch('/api/operations/last-reload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        walletAddress,
        solRecovered,
        operationType,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log(`📈 Updated SOL recovered: ${result.message}`);
  } catch (error) {
    console.error('❌ Failed to update SOL recovered:', error);
    throw error;
  }
} 