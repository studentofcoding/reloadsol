import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/utils/db';

const RENT_PER_CLOSE = 0.00203928;

interface LastReloadResponse {
  walletAddress: string;
  totalSolRecovered: number;
  lastOperationTime: string;
  operationType: 'swap' | 'close';
  shortWallet: string;
}

function shortWallet(address: string): string {
  return `${address.slice(0, 3)}..${address.slice(-3)}`;
}

function mapTokenOperation(row: {
  wallet_address: string;
  total_sol_recovered: number;
  close_count: number;
  last_operation_time: string;
}): LastReloadResponse {
  const totalSolRecovered =
    Number(row.total_sol_recovered) > 0
      ? Number(row.total_sol_recovered)
      : (row.close_count || 0) * RENT_PER_CLOSE;

  return {
    walletAddress: row.wallet_address,
    totalSolRecovered,
    lastOperationTime: row.last_operation_time,
    operationType: 'close',
    shortWallet: shortWallet(row.wallet_address),
  };
}

function mapTradingRecord(row: {
  wallet_address: string;
  operation_type: string;
  timestamp: string;
  data: unknown;
}): LastReloadResponse {
  const data =
    typeof row.data === 'string'
      ? (JSON.parse(row.data) as { solAmount?: number; successCount?: number })
      : (row.data as { solAmount?: number; successCount?: number });

  let totalSolRecovered = Number(data?.solAmount) || 0;
  if (totalSolRecovered <= 0 && row.operation_type === 'close') {
    totalSolRecovered = (data?.successCount || 0) * RENT_PER_CLOSE;
  }

  return {
    walletAddress: row.wallet_address,
    totalSolRecovered,
    lastOperationTime: row.timestamp,
    operationType: row.operation_type === 'close' ? 'close' : 'swap',
    shortWallet: shortWallet(row.wallet_address),
  };
}

export async function GET() {
  try {
    const { rows: data } = await query<{
      wallet_address: string;
      total_sol_recovered: number;
      close_count: number;
      last_operation_time: string;
    }>(
      `SELECT wallet_address, total_sol_recovered, close_count, last_operation_time
       FROM token_operations
       WHERE last_operation_time IS NOT NULL
         AND (close_count > 0 OR total_sol_recovered > 0)
       ORDER BY last_operation_time DESC
       LIMIT 10`,
    );

    if (data && data.length > 0) {
      return NextResponse.json(data.map(mapTokenOperation));
    }

    const { rows: records } = await query<{
      wallet_address: string;
      operation_type: string;
      timestamp: string;
      data: unknown;
    }>(
      `SELECT wallet_address, operation_type, timestamp, data
       FROM trading_records
       WHERE operation_type IN ('close', 'sell')
       ORDER BY timestamp DESC
       LIMIT 10`,
    );

    if (!records || records.length === 0) {
      return NextResponse.json([]);
    }

    return NextResponse.json(records.map(mapTradingRecord));
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
      operationType,
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
