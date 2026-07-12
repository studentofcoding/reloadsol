import type { ExecutionMode } from '@/strategies/types'
import { resolveExecutionMode } from '@/utils/execution-mode'

export function resolveTrendingSimMode(
  executionMode: ExecutionMode | undefined,
  globalRealAvailable: boolean,
): { isSimulated: boolean; skipBuy: boolean; reason?: string } {
  const r = resolveExecutionMode(executionMode, globalRealAvailable, {
    liveOnlyReason: 'live_only strategy requires keypair configuration',
    abParallel: 'follow_live',
  })
  return { isSimulated: r.isSimulated, skipBuy: r.skip, reason: r.reason }
}
