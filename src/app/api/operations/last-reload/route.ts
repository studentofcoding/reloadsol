import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/utils/db';

interface LastReloadResponse {
  walletAddress: string;
  totalSolRecovered: number;
  lastOperationTime: string;
  operationType: 'swap' | 'close';
  shortWallet: string;
}

export async function GET(request: NextRequest) {
  try {
    const { rows: data } = await query<{
      wallet_address: string;
      sol_balance: number;
      last_operation_time: string;
      close_count: number;
    }>(
      `SELECT wallet_address, sol_balance, last_operation_time, close_count
       FROM token_operations
       WHERE last_operation_time IS NOT NULL
         AND close_count > 0
       ORDER BY last_operation_time DESC
       LIMIT 10`,
    );

    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: 'No operations found' },
        { status: 404 }
      );
    }

    const operations = data.map((operation) => {
      const avgSolPerClose = 0.002;
      const totalSolRecovered = (operation.close_count || 0) * avgSolPerClose;
      const shortWallet = `${operation.wallet_address.slice(0, 3)}..${operation.wallet_address.slice(-3)}`;

      return {
        walletAddress: operation.wallet_address,
        totalSolRecovered,
        lastOperationTime: operation.last_operation_time,
        operationType: 'close' as const,
        shortWallet,
      };
    });

    return NextResponse.json(operations);
  } catch (error) {
    console.error('Error in last-reload API:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
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

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    const existing = await queryOne<{ total_sol_recovered: number }>(
      `SELECT total_sol_recovered FROM token_operations WHERE wallet_address = $1`,
      [walletAddress],
    );

    const currentTotal = existing?.total_sol_recovered || 0;
    const newTotal = currentTotal + solRecovered;
    const lastOperationTime = new Date().toISOString();

    await query(
      `INSERT INTO token_operations (wallet_address, total_sol_recovered, last_operation_time)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_address)
       DO UPDATE SET
         total_sol_recovered = EXCLUDED.total_sol_recovered,
         last_operation_time = EXCLUDED.last_operation_time`,
      [walletAddress, newTotal, lastOperationTime],
    );

    return NextResponse.json({
      success: true,
      walletAddress,
      totalSolRecovered: newTotal,
      addedAmount: solRecovered,
      message: `Added ${solRecovered} SOL, total now ${newTotal.toFixed(4)} SOL`,
    });
  } catch (error) {
    console.error('Error updating SOL recovered:', error);
    return NextResponse.json(
      {
        error: 'Failed to update SOL recovered',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
