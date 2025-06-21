import { NextRequest, NextResponse } from 'next/server';
import { directUpdateOperation } from '@/utils/supabase';

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
    const body: TrackOperationRequest = await request.json();
    
    // Input validation
    if (!body.walletAddress || typeof body.walletAddress !== 'string') {
      return NextResponse.json(
        { error: 'Invalid wallet address' },
        { status: 400 }
      );
    }

    if (!['buy', 'sell', 'close'].includes(body.operationType)) {
      return NextResponse.json(
        { error: 'Invalid operation type' },
        { status: 400 }
      );
    }

    if (typeof body.successCount !== 'number' || body.successCount < 0) {
      return NextResponse.json(
        { error: 'Invalid success count' },
        { status: 400 }
      );
    }

    // Validate wallet address format (Solana public key is 32 bytes base58 encoded)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    // Rate limiting check (simple in-memory, consider Redis for production)
    const rateLimitKey = `${body.walletAddress}-${Date.now() - (Date.now() % 60000)}`; // 1 minute window
    // TODO: Implement proper rate limiting

    // Map operation type for database
    const dbOperationType = mapOperationToType(body.operationType);
    
    // Update database
    await directUpdateOperation(
      body.walletAddress,
      dbOperationType,
      body.successCount,
      body.solBalance
    );

    // Calculate points earned
    const pointsEarned = calculatePoints(body.operationType, body.successCount);

    // Log successful operation (for monitoring)
    console.log(`Operation tracked: ${body.walletAddress} - ${body.operationType} - ${body.successCount} successful`, {
      timestamp: new Date().toISOString(),
      operationType: body.operationType,
      successCount: body.successCount,
      failureCount: body.failureCount || 0,
      pointsEarned,
      metadata: body.metadata
    });

    return NextResponse.json({
      success: true,
      pointsEarned,
      operationType: body.operationType,
      successCount: body.successCount,
      dbOperationType,
      message: `Successfully tracked ${body.successCount} ${body.operationType} operation(s)`
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