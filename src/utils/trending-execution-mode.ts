import type { ExecutionMode } from '@/strategies/types'

export function resolveTrendingSimMode(
  executionMode: ExecutionMode | undefined,
  globalRealAvailable: boolean,
): { isSimulated: boolean; skipBuy: boolean; reason?: string } {
  const mode = executionMode ?? 'sim_only'
  switch (mode) {
    case 'sim_only':
      return { isSimulated: true, skipBuy: false }
    case 'live_only':
      if (!globalRealAvailable) {
        return {
          isSimulated: true,
          skipBuy: true,
          reason: 'live_only strategy requires keypair configuration',
        }
      }
      return { isSimulated: false, skipBuy: false }
    case 'ab_parallel':
      // Trending bot does not dual-buy; follow global keypair availability.
      return { isSimulated: !globalRealAvailable, skipBuy: false }
    default:
      return { isSimulated: true, skipBuy: false }
  }
}
