'use server';

import { updateTag } from 'next/cache';
import { requireActionSession } from './auth';
import { CACHE_TAGS } from '@/lib/cache-tags';
import { query, queryOne } from '@/utils/db';
import { TokenLabel } from '@/utils/mcap-tracker';
import { log } from '@/utils/unified-logger';
import { markTokenRug } from '@/utils/rug-list/service';
import { removeRugEntry } from '@/utils/rug-list/db';

const VALID_LABELS: TokenLabel[] = [
  'valid',
  'traded_live',
  'potential',
  'rugged',
  'watching',
];

export async function setMcapTokenLabel(
  tokenAddress: string,
  label: TokenLabel | null,
) {
  const session = await requireActionSession();

  if (!tokenAddress || typeof tokenAddress !== 'string') {
    throw new Error('Token address is required and must be a string');
  }
  if (
    label !== null &&
    label !== undefined &&
    !VALID_LABELS.includes(label)
  ) {
    throw new Error(
      `Invalid label. Must be one of: ${VALID_LABELS.join(', ')}, or null to clear`,
    );
  }

  log.info('api_request', 'Updating token label', {
    tokenAddress,
    label: label || 'cleared',
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
    [tokenAddress, label || null],
  );

  if (label === 'rugged') {
    await markTokenRug({
      tokenAddress,
      tokenSymbol: existingToken.token_symbol,
      source: 'signals-label',
    });
  } else if (existingToken.label === 'rugged') {
    await removeRugEntry(tokenAddress);
  }

  log.info('api_request', 'Successfully updated token label', {
    tokenAddress,
    tokenSymbol: existingToken.token_symbol,
    previousLabel: existingToken.label || 'none',
    newLabel: label || 'cleared',
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
      newLabel: label,
    },
  };
}
