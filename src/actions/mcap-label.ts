'use server';

import { updateTag } from 'next/cache';
import { requireActionSession } from './auth';
import { CACHE_TAGS } from '@/lib/cache-tags';
import { query, queryOne } from '@/utils/db';
import { captureManualMcapRisingOhlc, TokenLabel } from '@/utils/mcap-tracker';
import { log } from '@/utils/unified-logger';
import { markTokenRug } from '@/utils/rug-list/service';
import { removeRugEntry } from '@/utils/rug-list/db';
import {
  TRACKER_WRITE_LABELS,
  coerceTrackerLabelWrite,
} from '@/utils/tracker-label';

const VALID_LABELS: TokenLabel[] = [...TRACKER_WRITE_LABELS];

export async function setMcapTokenLabel(
  tokenAddress: string,
  label: TokenLabel | 'potential' | null,
) {
  const session = await requireActionSession();

  if (!tokenAddress || typeof tokenAddress !== 'string') {
    throw new Error('Token address is required and must be a string');
  }
  const coerced = coerceTrackerLabelWrite(label);
  if (!coerced.ok) {
    throw new Error(
      `Invalid label. Must be one of: ${VALID_LABELS.join(', ')}, or null to clear`,
    );
  }
  const storedLabel = coerced.label;

  log.info('api_request', 'Updating token label', {
    tokenAddress,
    label: storedLabel || 'cleared',
  });

  const existingToken = await queryOne<{
    token_address: string;
    token_symbol: string;
    label: TokenLabel | null;
  }>(
    `SELECT token_address, token_symbol, label
     FROM token_mcap_tracking
     WHERE token_address = $1`,
    [tokenAddress],
  );

  if (!existingToken) {
    throw new Error('Token not found in tracking database');
  }

  await query(
    `UPDATE token_mcap_tracking SET label = $2 WHERE token_address = $1`,
    [tokenAddress, storedLabel || null],
  );

  if (storedLabel === 'rugged') {
    await markTokenRug({
      tokenAddress,
      tokenSymbol: existingToken.token_symbol,
      source: 'signals-label',
    });
  } else if (existingToken.label === 'rugged') {
    await removeRugEntry(tokenAddress);
  }

  if (storedLabel === 'rising') {
    await captureManualMcapRisingOhlc(tokenAddress, existingToken.token_symbol);
  }

  log.info('api_request', 'Successfully updated token label', {
    tokenAddress,
    tokenSymbol: existingToken.token_symbol,
    previousLabel: existingToken.label || 'none',
    newLabel: storedLabel || 'cleared',
  });

  updateTag(CACHE_TAGS.mcapLabels(session.address));
  updateTag(CACHE_TAGS.rug);
  updateTag(CACHE_TAGS.signals);

  return {
    success: true as const,
    data: {
      tokenAddress,
      tokenSymbol: existingToken.token_symbol,
      previousLabel: existingToken.label,
      newLabel: storedLabel,
    },
  };
}
