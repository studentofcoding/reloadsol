import 'server-only';
import { cookies } from 'next/headers';
import {
  parseWalletSessionToken,
  WALLET_SESSION_COOKIE,
  type WalletSessionPayload,
} from '@/utils/wallet-session';

export class UnauthorizedActionError extends Error {
  constructor(message = 'Connect your wallet and sign in to use this feature.') {
    super(message);
    this.name = 'UnauthorizedActionError';
  }
}

/**
 * Resolve the wallet session for a Server Action from the request cookie jar.
 *
 * Server Actions have access to `cookies()` from `next/headers` (no
 * `NextRequest`), so we validate the HMAC-signed session token directly with
 * `parseWalletSessionToken` — the same validator the route handlers use.
 */
export async function requireActionSession(): Promise<WalletSessionPayload> {
  const cookieStore = await cookies();
  const session = parseWalletSessionToken(
    cookieStore.get(WALLET_SESSION_COOKIE)?.value,
  );
  if (!session) {
    throw new UnauthorizedActionError();
  }
  return session;
}
