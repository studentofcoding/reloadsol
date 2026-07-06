import type { ExecutionMode } from '@/strategies/types'

export function resolveMcapExecutionMode(
  executionMode: ExecutionMode | undefined,
  liveAvailable: boolean,
): { isSimulated: boolean; skipOpen: boolean; reason?: string } {
  const mode = executionMode ?? 'sim_only'
  switch (mode) {
    case 'sim_only':
      return { isSimulated: true, skipOpen: false }
    case 'live_only':
      if (!liveAvailable) {
        return {
          isSimulated: true,
          skipOpen: true,
          reason:
            'live_only requires MCAP_LIVE_TRADING_ENABLED=true and TRADING_KEYPAIR_JSON',
        }
      }
      return { isSimulated: false, skipOpen: false }
    case 'ab_parallel':
      // ponytail: no dual-buy on mcap tracker — paper until explicitly wired
      return { isSimulated: true, skipOpen: false }
    default:
      return { isSimulated: true, skipOpen: false }
  }
}
