'use server';

import { updateTag } from 'next/cache';
import { requireActionSession } from './auth';
import { CACHE_TAGS } from '@/lib/cache-tags';
import { query } from '@/utils/db';
import { parseDbChain } from '@/utils/app-network-db';
import type { AppNetwork } from '@/utils/app-network';
import {
  insertTradingRecord,
  shouldSkipTradingRecord,
  updateTradingRecordData,
} from '@/utils/trading-records-db';
import { invalidateTradingRecordsCache } from '@/utils/trading-records-cache';
import { maybeRecordSignalsOutcome } from '@/utils/signals-outcome-capture';
import type { TrackingRecord } from '@/utils/trading-tracker';

function assertWalletMatchesSession(sessionAddress: string, wallet: unknown) {
  if (String(wallet ?? '').trim() !== sessionAddress) {
    throw new Error('Wallet address does not match signed session');
  }
}

export async function addTradingRecord(record: TrackingRecord) {
  const chain = parseDbChain(record.chain);

  if (chain === 'sol') {
    const session = await requireActionSession();
    assertWalletMatchesSession(session.address, record.walletAddress);
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(String(record.walletAddress))) {
    throw new Error('Robinhood wallet must be a 0x address');
  }

  if (shouldSkipTradingRecord(record)) {
    return { success: true as const, skipped: true as const };
  }

  await insertTradingRecord(record);

  try {
    await maybeRecordSignalsOutcome(record);
  } catch (outcomeErr) {
    console.warn('[records action] signals outcome capture failed:', outcomeErr);
  }

  invalidateTradingRecordsCache(record.walletAddress);
  updateTag(CACHE_TAGS.records(record.walletAddress));

  return { success: true as const };
}

export async function updateTradingRecord(id: string, record: TrackingRecord) {
  const chain = parseDbChain(record.chain);

  if (chain === 'sol') {
    const session = await requireActionSession();
    assertWalletMatchesSession(session.address, record.walletAddress);
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(String(record.walletAddress))) {
    throw new Error('Robinhood wallet must be a 0x address');
  }

  const updated = await updateTradingRecordData(id, record);
  if (!updated) {
    // The pending record never persisted (e.g. insert was skipped) — fall back
    // to inserting the terminal record so a confirmed/failed swap is kept.
    await insertTradingRecord(record);
  }

  invalidateTradingRecordsCache(record.walletAddress);
  updateTag(CACHE_TAGS.records(record.walletAddress));

  return { success: true as const };
}

export async function deleteTradingRecord(id: string, wallet: string) {
  const session = await requireActionSession();
  const walletAddress = String(wallet ?? '').trim();

  if (!id || !walletAddress) {
    throw new Error('Missing required parameters: id, wallet');
  }
  assertWalletMatchesSession(session.address, walletAddress);

  await query(
    `DELETE FROM trading_records WHERE id = $1 AND wallet_address = $2`,
    [id, walletAddress],
  );

  invalidateTradingRecordsCache(walletAddress);
  updateTag(CACHE_TAGS.records(walletAddress));

  return { success: true as const };
}
