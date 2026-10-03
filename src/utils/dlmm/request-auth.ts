import type { NextRequest } from 'next/server'
import { getWalletSessionFromRequest } from '@/utils/wallet-session'
import { isDlmmApiAuthorized } from '@/utils/dlmm/config'

/**
 * Mutating /api/dlmm/* position routes: accept either the configured DLMM_API_PASSWORD or a dev wallet
 * session. The dashboard no longer ships a default password in the client bundle, so a signed-in dev
 * wallet (already required by the proxy for this prefix) is enough. Both fail closed.
 */
export function isDlmmRequestAuthorized(
  req: NextRequest,
  password?: string | null,
): boolean {
  if (isDlmmApiAuthorized(password)) return true
  return getWalletSessionFromRequest(req)?.dev === true
}
