import type { AppNetwork } from '@/utils/app-network'
import {
  DEV_ROUTES,
  WALLET_REQUIRED_ROUTES,
  matchesRoutePrefix,
} from '@/config/route-access'

export type NetworkRouteEntry = {
  path: string
  networks: readonly AppNetwork[]
}

/** Batch 1: RH only buy/sell/dlmm (+ charts handled outside trade nav). */
export const ROUTE_NETWORK_REGISTRY: readonly NetworkRouteEntry[] = [
  { path: '/buy', networks: ['sol', 'robinhood'] },
  { path: '/sell', networks: ['sol', 'robinhood'] },
  { path: '/swap', networks: ['sol', 'robinhood'] },
  { path: '/history', networks: ['sol', 'robinhood'] },
  { path: '/pnl', networks: ['sol', 'robinhood'] },
  { path: '/dev/signals', networks: ['sol', 'robinhood'] },
  { path: '/dev/algo-tester', networks: ['sol'] },
  { path: '/dev/dlmm', networks: ['sol', 'robinhood'] },
  { path: '/dev/strategies', networks: ['sol', 'robinhood'] },
  { path: '/dev/rpc-tester', networks: ['sol'] },
  { path: '/dev/token-search', networks: ['sol'] },
  { path: '/dev/ohlc-labels', networks: ['sol'] },
  { path: '/dev/arbitrage', networks: ['sol'] },
  { path: '/dev/social', networks: ['sol'] },
]

const REGISTRY_PATHS = ROUTE_NETWORK_REGISTRY.map((e) => e.path)

/** Routes that participate in network gating (trade + known dev). */
export function isNetworkGatedRoute(pathname: string): boolean {
  return matchesRoutePrefix(pathname, REGISTRY_PATHS)
}

export function routeSupportsNetwork(
  pathname: string,
  network: AppNetwork,
): boolean {
  const path = pathname || ''
  const entry = ROUTE_NETWORK_REGISTRY.find(
    (e) => path === e.path || path.startsWith(`${e.path}/`),
  )
  if (!entry) {
    // Unknown trade/dev prefixes from route-access: treat as sol-only.
    if (
      matchesRoutePrefix(path, WALLET_REQUIRED_ROUTES) ||
      matchesRoutePrefix(path, DEV_ROUTES)
    ) {
      return network === 'sol'
    }
    return true
  }
  return entry.networks.includes(network)
}

export function defaultPathForNetwork(_network: AppNetwork): string {
  return '/buy'
}
