import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

interface TokenOperations {
  wallet_address: string;
  close_count: number;
  swap_count: number;
  sol_balance: number;
  last_operation_time: string;
  last_balance_update: string;
  telegram_handle: string | null;
  telegram_verified: boolean;
  telegram_verification_time: string | null;
  tx_level: number;
  ask_for_fund: boolean;
  amount_ask_for_fund: number;
  last_assistance_request: string | null;
}

// POST /api/operations/sync - Sync cached operations to database
export async function POST(request: NextRequest) {
  try {
    const { operations }: { operations: TokenOperations[] } = await request.json()

    if (!operations || !Array.isArray(operations)) {
      return NextResponse.json(
        { error: 'operations array is required' },
        { status: 400 }
      )
    }

    // Process each operation
    for (const operation of operations) {
      // Use atomic increment operation to prevent race conditions
      const { error } = await supabase.rpc('increment_operation_counts', {
        p_wallet_address: operation.wallet_address,
        p_swap_increment: operation.swap_count,
        p_close_increment: operation.close_count,
        p_sol_balance: operation.sol_balance,
        p_timestamp: operation.last_operation_time
      });

      if (error) {
        console.error('Error syncing operation:', error)
        throw error
      }
    }

    return NextResponse.json({ 
      success: true, 
      synced: operations.length 
    })
  } catch (error) {
    console.error('Error syncing operations:', error)
    return NextResponse.json(
      { 
        error: 'Failed to sync operations',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
} 