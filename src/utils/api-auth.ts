import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  getApiAccessTier,
  matchesApiPrefix,
  SERVICE_AUTH_API_PREFIXES,
} from '@/config/api-access';
import { secretsMatch } from '@/utils/secret-auth';
import { getWalletSessionFromRequest } from '@/utils/wallet-session';

function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function unauthorized(
  code: 'WALLET_SESSION_REQUIRED' | 'DEV_SESSION_REQUIRED',
  message: string,
): NextResponse {
  return NextResponse.json(
    { success: false, error: message, code },
    { status: 401 },
  );
}

function hasMatchingSecret(req: NextRequest, expected?: string | null): boolean {
  if (!expected) return false;
  const key = req.nextUrl.searchParams.get('key');
  if (key && secretsEqual(key, expected)) return true;

  const auth = req.headers.get('authorization');
  const prefix = 'Bearer ';
  if (auth?.startsWith(prefix) && secretsEqual(auth.slice(prefix.length), expected)) {
    return true;
  }

  return false;
}

/**
 * Only TRENDING_TRACKER_SECRET (`?key=` or `Authorization: Bearer`), constant-time.
 * Fails closed when the env is unset: there is no committed fallback secret.
 * Narrower than isServiceAuthorizedRequest (no DLMM/notification/PNL secrets, no dlmm password).
 */
export function hasTrendingTrackerSecret(req: NextRequest): boolean {
  return hasMatchingSecret(req, process.env.TRENDING_TRACKER_SECRET);
}

/** Cron jobs, webhooks, and bearer-protected maintenance endpoints. */
export function isServiceAuthorizedRequest(req: NextRequest): boolean {
  const pathname = req.nextUrl.pathname;
  const secrets = [
    process.env.TRENDING_TRACKER_SECRET,
    process.env.DLMM_SCREEN_SECRET,
    process.env.DLMM_MANAGE_SECRET,
    process.env.NOTIFICATION_SECRET_KEY,
    process.env.PNL_UPDATE_SECRET,
    process.env.PNL_UPDATE_TOKEN,
  ];

  if (secrets.some((secret) => hasMatchingSecret(req, secret))) {
    return true;
  }

  if (matchesApiPrefix(pathname, SERVICE_AUTH_API_PREFIXES)) {
    const key = req.nextUrl.searchParams.get('key');
    if (
      key &&
      [
        process.env.DLMM_SCREEN_SECRET,
        process.env.DLMM_MANAGE_SECRET,
        process.env.TRENDING_TRACKER_SECRET,
      ].some((secret) => secret && key === secret)
    ) {
      return true;
    }
  }

  if (pathname === '/api/dlmm/telegram') {
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const headerSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (webhookSecret && headerSecret === webhookSecret) {
      return true;
    }
  }

  // The DLMM dashboard password is only meaningful on /api/dlmm/*. It used to bypass EVERY tier on every
  // route (and the old default was a literal shipped in the client bundle). Scoped + fails closed when
  // DLMM_API_PASSWORD is unset.
  if (pathname === '/api/dlmm' || pathname.startsWith('/api/dlmm/')) {
    const dlmmPassword =
      req.headers.get('x-dlmm-password') ||
      req.nextUrl.searchParams.get('password');
    if (secretsMatch(dlmmPassword, process.env.DLMM_API_PASSWORD)) {
      return true;
    }
  }

  return false;
}

export function enforceApiAccess(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname;
  if (!pathname.startsWith('/api/')) {
    return null;
  }

  if (req.method === 'OPTIONS') {
    return null;
  }

  if (isServiceAuthorizedRequest(req)) {
    return null;
  }

  const tier = getApiAccessTier(pathname, req.method);
  if (tier === 'public' || tier === 'open') {
    return null;
  }

  const session = getWalletSessionFromRequest(req);
  if (!session) {
    return unauthorized(
      'WALLET_SESSION_REQUIRED',
      'Connect your wallet and sign in to use this API.',
    );
  }

  if (tier === 'wallet') {
    return null;
  }

  if (tier === 'dev' && !session.dev) {
    return unauthorized(
      'DEV_SESSION_REQUIRED',
      'Dev wallet session required for this API.',
    );
  }

  return null;
}

export function requireWalletSession(
  req: NextRequest,
): { session: NonNullable<ReturnType<typeof getWalletSessionFromRequest>> } | NextResponse {
  const session = getWalletSessionFromRequest(req);
  if (!session) {
    return unauthorized(
      'WALLET_SESSION_REQUIRED',
      'Connect your wallet and sign in to use this API.',
    );
  }
  return { session };
}

export function requireDevSession(
  req: NextRequest,
): { session: NonNullable<ReturnType<typeof getWalletSessionFromRequest>> } | NextResponse {
  const walletResult = requireWalletSession(req);
  if (walletResult instanceof NextResponse) {
    return walletResult;
  }

  if (!walletResult.session.dev) {
    return unauthorized(
      'DEV_SESSION_REQUIRED',
      'Dev wallet session required for this API.',
    );
  }

  return walletResult;
}

export function assertSessionWallet(
  sessionAddress: string,
  requestedWallet?: string | null,
): NextResponse | null {
  if (!requestedWallet) return null;
  if (sessionAddress !== requestedWallet.trim()) {
    return NextResponse.json(
      {
        success: false,
        error: 'Wallet address does not match signed session',
        code: 'WALLET_MISMATCH',
      },
      { status: 403 },
    );
  }
  return null;
}
