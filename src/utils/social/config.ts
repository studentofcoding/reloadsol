import { secretsMatch } from '@/utils/secret-auth'

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

export const SOCIAL_CONFIG = {
  ingestSecret:
    process.env.SOCIAL_INGEST_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    '',
  rollupSecret:
    process.env.SOCIAL_ROLLUP_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    '',
  walletPollSecret:
    process.env.SOCIAL_WALLET_POLL_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    '',
  /** When true, social gates only log skip/boost diffs without blocking trades. */
  shadowMode: parseBoolEnv('SOCIAL_SHADOW_MODE', true),
  ingestBaseUrl:
    process.env.SOCIAL_INGEST_BASE_URL ||
    process.env.API_HOST ||
    process.env.NEXT_PUBLIC_API_HOST ||
    'http://localhost:3000',
}

export function isSocialIngestAuthorized(secret?: string | null): boolean {
  return !!secret && secret === SOCIAL_CONFIG.ingestSecret
}

export function isSocialRollupAuthorized(secret?: string | null): boolean {
  return !!secret && secret === SOCIAL_CONFIG.rollupSecret
}

export function isSocialWalletPollAuthorized(secret?: string | null): boolean {
  return !!secret && secret === SOCIAL_CONFIG.walletPollSecret
}
