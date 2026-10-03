// Server-only (gmgn-api -> redis-cache -> ioredis). Never import from a client component or hook;
// the client-safe helpers live in ./gmgn-bound-wallets. (No `server-only` package installed.)
import { userInfo } from './gmgn-api'
import {
  getGmgnBoundWalletsFromEnv,
  parseBoundWalletsFromUserInfo,
  type GmgnBoundWallets,
} from './gmgn-bound-wallets'

let cache: { at: number; value: GmgnBoundWallets } | null = null
const CACHE_MS = 60_000

/**
 * Env overrides win; otherwise fetch /v1/user/info and parse bound wallets.
 * Cached briefly so bound-wallets + trade routes do not hammer GMGN.
 */
export async function resolveGmgnBoundWallets(): Promise<GmgnBoundWallets> {
  const fromEnv = getGmgnBoundWalletsFromEnv()
  if (fromEnv.sol && fromEnv.evm) return fromEnv

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return {
      sol: fromEnv.sol ?? cache.value.sol,
      evm: fromEnv.evm ?? cache.value.evm,
    }
  }

  if (!process.env.GMGN_API_KEY?.trim()) {
    return fromEnv
  }

  try {
    const info = await userInfo()
    const parsed = parseBoundWalletsFromUserInfo(info)
    cache = { at: Date.now(), value: parsed }
    return {
      sol: fromEnv.sol ?? parsed.sol,
      evm: fromEnv.evm ?? parsed.evm,
    }
  } catch {
    return fromEnv
  }
}
