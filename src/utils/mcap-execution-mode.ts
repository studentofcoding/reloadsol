import type { ExecutionMode } from '@/strategies/types'
import { resolveExecutionMode } from '@/utils/execution-mode'

export function resolveMcapExecutionMode(
  executionMode: ExecutionMode | undefined,
  liveAvailable: boolean,
): { isSimulated: boolean; skipOpen: boolean; reason?: string } {
  const r = resolveExecutionMode(executionMode, liveAvailable, {
    liveOnlyReason:
      'live_only requires MCAP_LIVE_TRADING_ENABLED=true and TRADING_KEYPAIR_JSON',
    abParallel: 'sim_only',
  })
  return { isSimulated: r.isSimulated, skipOpen: r.skip, reason: r.reason }
}
