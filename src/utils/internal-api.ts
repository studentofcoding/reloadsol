/**
 * Server-to-self HTTP calls (web -> http://web:3000/api/...).
 *
 * The API proxy (src/proxy.ts -> enforceApiAccess) gates wallet/dev routes on a wallet session cookie. A call the
 * server makes to its own API carries no cookie, so it must present the service secret instead; the proxy accepts
 * `Authorization: Bearer <TRENDING_TRACKER_SECRET>` on every tier (see isServiceAuthorizedRequest).
 *
 * Browser code never gets the header: `typeof window !== 'undefined'` returns `{}` and server-only env vars are not
 * inlined into client bundles, so the secret cannot leak through here.
 */

/** Headers for a server-side call to this app's own API. Empty in the browser or when no secret is configured. */
export function internalAuthHeaders(): Record<string, string> {
  if (typeof window !== 'undefined') return {}
  const secret = process.env.TRENDING_TRACKER_SECRET?.trim()
  return secret ? { Authorization: `Bearer ${secret}` } : {}
}

/** Merge internal auth into existing fetch headers (existing keys win, so an explicit Authorization is kept). */
export function withInternalAuth(headers?: HeadersInit): Record<string, string> {
  const base: Record<string, string> = {}
  if (headers) new Headers(headers).forEach((v, k) => { base[k] = v })
  return { ...internalAuthHeaders(), ...base }
}
