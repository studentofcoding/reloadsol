import {
  coerceAppNetwork,
  type AppNetwork,
} from '@/utils/app-network'

/**
 * When RH access flips, restore stored preference on grant; force sol on revoke.
 * Does not touch storage when the gate is unchanged (avoids clobber on disconnect).
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
  return { network: 'sol', shouldWrite: true }
}
