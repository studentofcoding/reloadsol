import {
  coerceAppNetwork,
  type AppNetwork,
} from '@/utils/app-network'

/**
 * When RH access flips, restore the user's stored preference on grant; keep
 * the current network on revoke (don't clobber). The per-chain pages are now
 * the source of truth — `/buy/robinhood` should still render even if the user
 * disconnected Rabby. The setNetwork() callback still coerces manual
 * selections, so a user without RH access who manually picks Robinhood gets
 * flipped back to sol.
 */
export function resolveNetworkOnRhGateChange(params: {
  prevCanUseRh: boolean
  canUseRh: boolean
  current: AppNetwork
  stored: AppNetwork
}): { network: AppNetwork; shouldWrite: boolean } {
  if (params.prevCanUseRh === params.canUseRh) {
    return { network: params.current, shouldWrite: false }
  }
  if (params.canUseRh) {
    return {
      network: coerceAppNetwork(params.stored, true),
      shouldWrite: true,
    }
  }
  return { network: params.current, shouldWrite: false }
}
