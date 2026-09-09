import type { AppNetwork } from '@/utils/app-network'

function chainSegment(chain: AppNetwork): string {
  return chain === 'robinhood' ? 'robinhood' : 'solana'
}

/**
 * When switching networks, stay on the SAME page section:
 * /buy/solana -> /buy/robinhood, /swap -> /swap/robinhood,
 * dev search-token -> its chain page. Non-trade routes keep /sell/{chain}.
 */
export function chainSwitchTarget(pathname: string, next: AppNetwork): string {
  const seg = chainSegment(next)
  const tradeMatch =
    pathname.match(/^\/(buy|sell|swap)(?:\/(solana|robinhood))?\/?$/) ?? null
  if (tradeMatch) {
    return `/${tradeMatch[1]}/${seg}`
  }
  const devMatch =
    pathname.match(/^\/dev\/search-token(?:\/(solana|robinhood))?\/?$/) ?? null
  if (devMatch) {
    return `/dev/search-token/${seg}`
  }
  return `/sell/${seg}`
}

/**
 * NetworkPreface writes the URL-declared chain into stored app network.
 * Apply only on the first settle (landing / hard navigation onto the page).
 * After that, a header toggle may change `storedNetwork` while this page is
 * still mounted; re-applying would snap the toggle back before navigation
 * completes.
 */
export function shouldApplyUrlNetworkToStore(params: {
  urlNetwork: AppNetwork
  storedNetwork: AppNetwork
  alreadyApplied: boolean
}): boolean {
  if (params.alreadyApplied) return false
  return params.urlNetwork !== params.storedNetwork
}
