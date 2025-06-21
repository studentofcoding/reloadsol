// Client-side utilities for secure operations tracking

interface TrackOperationRequest {
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
}

interface TrackOperationResponse {
  success: boolean;
  pointsEarned: number;
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
 * Track a successful operation (buy, sell, or close) securely via server route
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
    const requestData: TrackOperationRequest = {
      walletAddress,
      operationType,
      successCount,
      failureCount: options?.failureCount,
      solBalance: options?.solBalance,
      metadata: {
        tokenMints: options?.tokenMints,
        solAmount: options?.solAmount,
        signatures: options?.signatures,
      }
    };

    const response = await fetch('/api/operations/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }

    const result: TrackOperationResponse = await response.json();
    
    // Update total SOL recovered if it's a sell operation with SOL amount
    if (operationType === 'sell' && options?.solAmount && options.solAmount > 0) {
      try {
        await updateSolRecovered(walletAddress, options.solAmount, operationType);
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