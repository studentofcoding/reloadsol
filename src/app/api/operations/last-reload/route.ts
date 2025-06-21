import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';

interface LastReloadResponse {
  walletAddress: string;
  totalSolRecovered: number;
  lastOperationTime: string;
  operationType: 'swap' | 'close';
  shortWallet: string;
}

export async function GET(request: NextRequest) {
  try {
    // Get the most recent operation from all wallets
    const { data, error } = await supabase
      .from('token_operations')
      .select('wallet_address, sol_balance, last_operation_time, swap_count, close_count')
      .not('last_operation_time', 'is', null)
      .order('last_operation_time', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      console.error('Error fetching last reload:', error);
      return NextResponse.json(
        { error: 'Failed to fetch last operation' },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: 'No operations found' },
        { status: 404 }
      );
    }

    // Calculate total SOL recovered based on operation counts
    // Assuming average of 0.1 SOL per swap and 0.002 SOL per close (rent recovery)
    const avgSolPerSwap = 0.1;
    const avgSolPerClose = 0.002;
    const totalSolRecovered = (data.swap_count || 0) * avgSolPerSwap + (data.close_count || 0) * avgSolPerClose;

    // Determine the primary operation type based on counts
    const operationType = (data.swap_count || 0) > (data.close_count || 0) ? 'swap' : 'close';

    // Format wallet address (first 3 and last 3 characters)
    const shortWallet = `${data.wallet_address.slice(0, 3)}..${data.wallet_address.slice(-3)}`;

    const response: LastReloadResponse = {
      walletAddress: data.wallet_address,
      totalSolRecovered,
      lastOperationTime: data.last_operation_time,
      operationType,
      shortWallet
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('Error in last-reload API:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

// POST endpoint to update total SOL recovered for a specific operation
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, solRecovered, operationType } = body;

    // Input validation
    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json(
        { error: 'Invalid wallet address' },
        { status: 400 }
      );
    }

    if (typeof solRecovered !== 'number' || solRecovered < 0) {
      return NextResponse.json(
        { error: 'Invalid SOL amount' },
        { status: 400 }
      );
    }

    // Validate wallet address format
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    // Get current data
    const { data: existing } = await supabase
      .from('token_operations')
      .select('total_sol_recovered')
      .eq('wallet_address', walletAddress)
      .single();

    const currentTotal = existing?.total_sol_recovered || 0;
    const newTotal = currentTotal + solRecovered;

    // Update the total SOL recovered
    const { error } = await supabase
      .from('token_operations')
      .upsert({
        wallet_address: walletAddress,
        total_sol_recovered: newTotal,
        last_operation_time: new Date().toISOString()
      }, {
        onConflict: 'wallet_address'
      });

    if (error) {
      console.error('Error updating SOL recovered:', error);
      return NextResponse.json(
        { error: 'Failed to update SOL recovered' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      walletAddress,
      totalSolRecovered: newTotal,
      addedAmount: solRecovered,
      message: `Added ${solRecovered} SOL, total now ${newTotal.toFixed(4)} SOL`
    });

  } catch (error) {
    console.error('Error updating SOL recovered:', error);
    return NextResponse.json(
      { 
        error: 'Failed to update SOL recovered',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
} 