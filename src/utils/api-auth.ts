import { NextRequest, NextResponse } from 'next/server';
import {
  getApiAccessTier,
  matchesApiPrefix,
  SERVICE_AUTH_API_PREFIXES,
} from '@/config/api-access';
import { getWalletSessionFromRequest } from '@/utils/wallet-session';

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
  if (key && key === expected) return true;

  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${expected}`) return true;

  return false;
}

/** Cron jobs, webhooks, and bearer-protected maintenance endpoints. */
export function isServiceAuthorizedRequest(req: NextRequest): boolean {
  if (req.headers.get('vercel-cron') === '1') {
    return true;
  }

  const userAgent = req.headers.get('user-agent') ?? '';
  if (userAgent.includes('vercel-cron') || userAgent.includes('reloadsol-cron-service')) {
    return true;
  }

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

  const dlmmPassword =
    req.headers.get('x-dlmm-password') ||
    req.nextUrl.searchParams.get('password');
  if (
    dlmmPassword &&
    dlmmPassword === (process.env.DLMM_API_PASSWORD || 'earlytrencher')
  ) {
    return true;
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
