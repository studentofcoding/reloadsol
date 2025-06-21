import { NextRequest, NextResponse } from 'next/server';
import { fetchWalletStats } from '@/utils/points';

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

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');

    // Input validation
    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json(
        { error: 'Wallet address is required' },
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

    // Fetch wallet stats from database
    const stats = await fetchWalletStats(walletAddress);

    // Get detailed breakdown from database for more accurate reporting
    const { supabase } = await import('@/utils/supabase');
    const { data: detailedData, error } = await supabase
      .from('token_operations')
      .select('swap_count, close_count')
      .eq('wallet_address', walletAddress)
      .single();

    let swapCount = 0;
    let closeCount = 0;

    if (!error && detailedData) {
      swapCount = detailedData.swap_count || 0;
      closeCount = detailedData.close_count || 0;
    }

    // Calculate detailed breakdown
    const swapPoints = swapCount * 10;
    const closePoints = closeCount * 5;

    const response: WalletStatsResponse = {
      points: stats.points,
      tokenCount: stats.tokenCount,
      swapCount,
      closeCount,
      breakdown: {
        swapPoints,
        closePoints
      }
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('Error fetching wallet points:', error);
    
    return NextResponse.json(
      { 
        error: 'Failed to fetch wallet points',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// POST endpoint for batch wallet stats (if needed)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddresses } = body;

    if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
      return NextResponse.json(
        { error: 'Invalid wallet addresses array' },
        { status: 400 }
      );
    }

    // Limit batch size for performance
    if (walletAddresses.length > 50) {
      return NextResponse.json(
        { error: 'Maximum 50 wallet addresses allowed per batch' },
        { status: 400 }
      );
    }

    // Validate all wallet addresses
    for (const address of walletAddresses) {
      if (!address || typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        return NextResponse.json(
          { error: `Invalid wallet address format: ${address}` },
          { status: 400 }
        );
      }
    }

    // Fetch stats for all wallets
    const results = await Promise.all(
      walletAddresses.map(async (walletAddress: string) => {
        try {
          const stats = await fetchWalletStats(walletAddress);
          return {
            walletAddress,
            ...stats,
            error: null
          };
        } catch (error) {
          return {
            walletAddress,
            points: 0,
            tokenCount: 0,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      })
    );

    return NextResponse.json({
      success: true,
      results,
      count: results.length
    });

  } catch (error) {
    console.error('Error fetching batch wallet points:', error);
    
    return NextResponse.json(
      { 
        error: 'Failed to fetch batch wallet points',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
} 