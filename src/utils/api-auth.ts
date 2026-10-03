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

export type TierEnforceMode = 'enforce' | 'log' | 'off';

/**
 * `API_TIER_ENFORCE` (read per request, so flipping it needs a container restart/recreate but NO rebuild):
 *   unset / anything else -> enforce (default)
 *   `log`                 -> evaluate and log would-be 401s with route + caller, never block
 *   `0` / `off` / `false` -> proxy tier checks disabled entirely (kill switch). Per-handler guards still apply.
 */
export function tierEnforceMode(env: Record<string, string | undefined> = process.env): TierEnforceMode {
  const v = env.API_TIER_ENFORCE?.trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return 'off';
  if (v === 'log') return 'log';
  return 'enforce';
}

type TierDecision = {
  blocked: NextResponse | null;
  tier: ReturnType<typeof getApiAccessTier>;
  reason: 'ok' | 'WALLET_SESSION_REQUIRED' | 'DEV_SESSION_REQUIRED';
  session: 'none' | 'wallet' | 'dev';
};

function evaluateApiAccess(req: NextRequest): TierDecision | null {
  const pathname = req.nextUrl.pathname;
  if (!pathname.startsWith('/api/')) return null;
  if (req.method === 'OPTIONS') return null;
  if (isServiceAuthorizedRequest(req)) return null;

  const tier = getApiAccessTier(pathname, req.method);
  if (tier === 'public' || tier === 'open') {
    return { blocked: null, tier, reason: 'ok', session: 'none' };
  }

  const session = getWalletSessionFromRequest(req);
  if (!session) {
    return {
      blocked: unauthorized('WALLET_SESSION_REQUIRED', 'Connect your wallet and sign in to use this API.'),
      tier,
      reason: 'WALLET_SESSION_REQUIRED',
      session: 'none',
    };
  }
  if (tier === 'dev' && !session.dev) {
    return {
      blocked: unauthorized('DEV_SESSION_REQUIRED', 'Dev wallet session required for this API.'),
      tier,
      reason: 'DEV_SESSION_REQUIRED',
      session: 'wallet',
    };
  }
  return { blocked: null, tier, reason: 'ok', session: session.dev ? 'dev' : 'wallet' };
}

const lastLogged = new Map<string, { at: number; suppressed: number }>();
const LOG_EVERY_MS = 10_000;

/** One line per (action, method, path) per 10 s: route + caller, no query string (it can carry `?key=`). */
function logTierDecision(
  action: 'would_block' | 'blocked',
  req: NextRequest,
  d: TierDecision,
): void {
  const path = req.nextUrl.pathname;
  const key = `${action}|${req.method}|${path}`;
  const now = Date.now();
  const prev = lastLogged.get(key);
  if (prev && now - prev.at < LOG_EVERY_MS) {
    prev.suppressed += 1;
    return;
  }
  if (lastLogged.size > 2000) lastLogged.clear();
  lastLogged.set(key, { at: now, suppressed: 0 });

  let referer = '';
  try {
    const r = req.headers.get('referer');
    if (r) referer = new URL(r).pathname;
  } catch {
    // ignore malformed referer
  }
  const host = (req.headers.get('host') || '').split(':')[0];
  const line = {
    action,
    tier: d.tier,
    reason: d.reason,
    session: d.session,
    method: req.method,
    path,
    caller: host === 'web' ? 'internal' : req.headers.get('origin') || referer ? 'browser' : 'other',
    referer,
    ua: (req.headers.get('user-agent') || '').slice(0, 60),
    ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim(),
    suppressedSince: prev?.suppressed ?? 0,
  };
  console.warn(`[api-tier] ${JSON.stringify(line)}`);
}

export function enforceApiAccess(req: NextRequest): NextResponse | null {
  const mode = tierEnforceMode();
  if (mode === 'off') return null;

  const decision = evaluateApiAccess(req);
  if (!decision || !decision.blocked) return null;

  if (mode === 'log') {
    logTierDecision('would_block', req, decision);
    return null;
  }
  logTierDecision('blocked', req, decision);
  return decision.blocked;
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

/**
 * Handler-level twin of the proxy's wallet tier for routes that must not depend on the proxy alone
 * (rh/rpc, kyber/*). Honours the API_TIER_ENFORCE kill switch / log mode so one flag controls everything,
 * and lets a service-secret caller through just like the proxy does.
 */
export function guardWalletTier(req: NextRequest): NextResponse | null {
  if (tierEnforceMode() !== 'enforce') return null;
  if (isServiceAuthorizedRequest(req)) return null;
  const result = requireWalletSession(req);
  return result instanceof NextResponse ? result : null;
}
