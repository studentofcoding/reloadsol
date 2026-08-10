'use server';

import { updateTag } from 'next/cache';
import { requireActionSession } from './auth';
import { CACHE_TAGS } from '@/lib/cache-tags';
import { query } from '@/utils/db';

const POINTS_CONFIG = {
  SWAP: 10,
  CLOSE: 5,
};

function calculatePoints(
  operationType: 'buy' | 'sell' | 'close',
  successCount: number,
): number {
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

export interface TrackOperationInput {
  walletAddress: string;
  operationType: 'buy' | 'sell' | 'close';
  successCount: number;
  solBalance?: number;
}

export async function trackOperation(input: TrackOperationInput) {
  const session = await requireActionSession();

  const { walletAddress, operationType, successCount, solBalance } = input;

  if (!walletAddress || typeof walletAddress !== 'string') {
    throw new Error('Invalid wallet address');
  }
  if (!['buy', 'sell', 'close'].includes(operationType)) {
    throw new Error('Invalid operation type');
  }
  if (typeof successCount !== 'number' || successCount < 0) {
    throw new Error('Invalid success count');
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    throw new Error('Invalid wallet address format');
  }
  if (session.address !== walletAddress) {
    throw new Error('Wallet address does not match signed session');
  }

  const dbOperationType = operationType === 'close' ? 'close' : 'swap';
  const timestamp = new Date().toISOString();
  const swapIncrement = dbOperationType === 'swap' ? successCount : 0;
  const closeIncrement = dbOperationType === 'close' ? successCount : 0;

  await query(`SELECT increment_operation_counts($1, $2, $3, $4, $5)`, [
    walletAddress,
    swapIncrement,
    closeIncrement,
    solBalance ?? null,
    timestamp,
  ]);

  const pointsEarned = calculatePoints(operationType, successCount);

  updateTag(CACHE_TAGS.records(walletAddress));

  return { success: true as const, pointsEarned };
}

export interface SyncOperationInput {
  wallet_address: string;
  swap_count: number;
  close_count: number;
  sol_balance?: number | null;
  last_operation_time: string;
}

export async function syncOperations(operations: SyncOperationInput[]) {
  const session = await requireActionSession();

  if (!operations || !Array.isArray(operations)) {
    throw new Error('operations array is required');
  }

  const walletAddresses = new Set<string>();
  for (const operation of operations) {
    if (session.address !== operation.wallet_address) {
      throw new Error('Wallet address does not match signed session');
    }
    walletAddresses.add(operation.wallet_address);
    await query(`SELECT increment_operation_counts($1, $2, $3, $4, $5)`, [
      operation.wallet_address,
      operation.swap_count,
      operation.close_count,
      operation.sol_balance ?? null,
      operation.last_operation_time,
    ]);
  }

  for (const wallet of walletAddresses) {
    updateTag(CACHE_TAGS.records(wallet));
  }

  return { success: true as const, synced: operations.length };
}
