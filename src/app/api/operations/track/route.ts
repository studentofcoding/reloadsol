import { NextRequest, NextResponse } from 'next/server';
import { assertSessionWallet, requireWalletSession } from '@/utils/api-auth';
import { supabase } from '@/utils/supabase';

interface TrackOperationRequest {
  walletAddress: string;
  operationType: 'buy' | 'sell' | 'close';
  successCount: number;
  failureCount?: number;
  solBalance?: number;
  // Optional metadata for logging
  metadata?: {
    tokenMints?: string[];
    solAmount?: number;
    signatures?: string[];
  };
}

// New simplified format for direct API calls
interface DirectUpdateRequest {
  walletAddress: string;
  type: 'close' | 'swap';
  count: number;
  solBalance?: number;
}

// Points calculation (matching points.ts logic)
const POINTS_CONFIG = {
  SWAP: 10, // Points per successful buy/sell
  CLOSE: 5, // Points per successful close
};

function calculatePoints(operationType: 'buy' | 'sell' | 'close', successCount: number): number {
  switch (operationType) {
    case 'buy':
    case 'sell':
      return successCount * POINTS_CONFIG.SWAP;
    case 'close':
      return successCount * POINTS_CONFIG.CLOSE;
    default:
      return 0;
  }
}

function mapOperationToType(operationType: 'buy' | 'sell' | 'close'): 'swap' | 'close' {
  return operationType === 'close' ? 'close' : 'swap';
}

// Direct update function (server-side version)
async function directUpdateOperation(
  walletAddress: string, 
  type: 'close' | 'swap',
  count: number,
  solBalance?: number,
) {
  // Atomic operation using raw SQL to prevent race conditions
  const timestamp = new Date().toISOString();
  
  // Build the SQL query for atomic increment
  const swapIncrement = type === 'swap' ? count : 0;
  const closeIncrement = type === 'close' ? count : 0;
  
  // Use PostgreSQL's atomic upsert via Supabase RPC
  // This calls a stored procedure that handles the atomic increment
  // 
  // REQUIRED: Create this PostgreSQL function in your Supabase database:
  // 
  // CREATE OR REPLACE FUNCTION increment_operation_counts(
  //   p_wallet_address TEXT,
  //   p_swap_increment INTEGER,
  //   p_close_increment INTEGER,
  //   p_sol_balance NUMERIC DEFAULT NULL,
  //   p_timestamp TIMESTAMPTZ DEFAULT NOW()
  // ) RETURNS VOID AS $$
  // BEGIN
  //   INSERT INTO token_operations (
  //     wallet_address, 
  //     swap_count, 
  //     close_count, 
  //     last_operation_time,
  //     sol_balance,
  //     last_balance_update
  //   ) VALUES (
  //     p_wallet_address, 
  //     p_swap_increment, 
  //     p_close_increment, 
  //     p_timestamp,
  //     COALESCE(p_sol_balance, 0),
  //     p_timestamp
  //   )
  //   ON CONFLICT (wallet_address) 
  //   DO UPDATE SET
  //     swap_count = COALESCE(token_operations.swap_count, 0) + p_swap_increment,
  //     close_count = COALESCE(token_operations.close_count, 0) + p_close_increment,
  //     last_operation_time = p_timestamp,
  //     sol_balance = CASE 
  //       WHEN p_sol_balance IS NOT NULL THEN p_sol_balance 
  //       ELSE COALESCE(token_operations.sol_balance, 0) 
  //     END,
  //     last_balance_update = CASE 
  //       WHEN p_sol_balance IS NOT NULL THEN p_timestamp 
  //       ELSE COALESCE(token_operations.last_balance_update, token_operations.last_operation_time) 
  //     END;
  // END;
  // $$ LANGUAGE plpgsql;
  //
  const { error } = await supabase.rpc('increment_operation_counts', {
    p_wallet_address: walletAddress,
    p_swap_increment: swapIncrement,
    p_close_increment: closeIncrement,
    p_sol_balance: solBalance,
    p_timestamp: timestamp
  });

  if (error) throw error;
}

/* SECURITY_REVIEW
Security considerations for this endpoint:
1. Input validation: Validate wallet address format, operation types, and counts
2. Rate limiting: Prevent spam by limiting requests per wallet per time period
3. Sanitization: Clean all inputs to prevent injection attacks
4. Authentication: Could add wallet signature verification for higher security
5. Audit logging: Log all operations for monitoring and fraud detection
*/

export async function POST(request: NextRequest) {
  try {
    const auth = requireWalletSession(request);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const body = await request.json();
    
    // Handle both old and new request formats
    let walletAddress: string;
    let operationType: 'buy' | 'sell' | 'close';
    let successCount: number;
    let solBalance: number | undefined;
    
    if ('type' in body) {
      // New simplified format from client supabase utils
      const directUpdate = body as DirectUpdateRequest;
      walletAddress = directUpdate.walletAddress;
      operationType = directUpdate.type === 'close' ? 'close' : 'buy'; // Default to buy for swap
      successCount = directUpdate.count;
      solBalance = directUpdate.solBalance;
    } else {
      // Old format
      const trackRequest = body as TrackOperationRequest;
      walletAddress = trackRequest.walletAddress;
      operationType = trackRequest.operationType;
      successCount = trackRequest.successCount;
      solBalance = trackRequest.solBalance;
    }
    
    // Input validation
    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json(
        { error: 'Invalid wallet address' },
        { status: 400 }
      );
    }

    if (!['buy', 'sell', 'close'].includes(operationType)) {
      return NextResponse.json(
        { error: 'Invalid operation type' },
        { status: 400 }
      );
    }

    if (typeof successCount !== 'number' || successCount < 0) {
      return NextResponse.json(
        { error: 'Invalid success count' },
        { status: 400 }
      );
    }

    // Validate wallet address format (Solana public key is 32 bytes base58 encoded)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    const mismatch = assertSessionWallet(auth.session.address, walletAddress);
    if (mismatch) {
      return mismatch;
    }

    // Rate limiting check (simple in-memory, consider Redis for production)
    const rateLimitKey = `${walletAddress}-${Date.now() - (Date.now() % 60000)}`; // 1 minute window
    // TODO: Implement proper rate limiting

    // Map operation type for database
    const dbOperationType = mapOperationToType(operationType);
    
    // Update database
    await directUpdateOperation(
      walletAddress,
      dbOperationType,
      successCount,
      solBalance
    );

    // Calculate points earned
    const pointsEarned = calculatePoints(operationType, successCount);

    // Log successful operation (for monitoring)
    console.log(`Operation tracked: ${walletAddress} - ${operationType} - ${successCount} successful`, {
      timestamp: new Date().toISOString(),
      operationType,
      successCount,
      pointsEarned,
    });

    return NextResponse.json({
      success: true,
      pointsEarned,
      operationType,
      successCount,
      dbOperationType,
      message: `Successfully tracked ${successCount} ${operationType} operation(s)`
    });

  } catch (error) {
    console.error('Error tracking operation:', error);
    
    return NextResponse.json(
      { 
        error: 'Failed to track operation',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// GET endpoint for health check
export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    endpoint: 'operations/track',
    supportedMethods: ['POST'],
    timestamp: new Date().toISOString()
  });
} 