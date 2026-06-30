import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/utils/db';

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
    const { operations }: { operations: TokenOperations[] } = await request.json();

    if (!operations || !Array.isArray(operations)) {
      return NextResponse.json(
        { error: 'operations array is required' },
        { status: 400 }
      );
    }

    for (const operation of operations) {
      await query(
        `SELECT increment_operation_counts($1, $2, $3, $4, $5)`,
        [
          operation.wallet_address,
          operation.swap_count,
          operation.close_count,
          operation.sol_balance ?? null,
          operation.last_operation_time,
        ],
      );
    }

    return NextResponse.json({
      success: true,
      synced: operations.length,
    });
  } catch (error) {
    console.error('Error syncing operations:', error);
    return NextResponse.json(
      {
        error: 'Failed to sync operations',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
