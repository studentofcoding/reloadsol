import type { ExecutionMode } from '@/strategies/types'

export type ResolvedExecution = {
  isSimulated: boolean
  skip: boolean
  reason?: string
}

/**
 * Shared execution-mode resolver.
 * `abParallel`: 'follow_live' = paper if no live keypair; 'sim_only' = always paper.
 */
export function resolveExecutionMode(
  executionMode: ExecutionMode | undefined,
  liveAvailable: boolean,
  opts: {
    liveOnlyReason: string
    abParallel: 'follow_live' | 'sim_only'
  },
): ResolvedExecution {
  const mode = executionMode ?? 'sim_only'
  switch (mode) {
    case 'sim_only':
      return { isSimulated: true, skip: false }
    case 'live_only':
      if (!liveAvailable) {
        return {
          isSimulated: true,
          skip: true,
          reason: opts.liveOnlyReason,
        }
      }
      return { isSimulated: false, skip: false }
    case 'ab_parallel':
      if (opts.abParallel === 'sim_only') {
        // ponytail: mcap stays paper until dual-buy is wired
        return { isSimulated: true, skip: false }
      }
      return { isSimulated: !liveAvailable, skip: false }
    default:
      return { isSimulated: true, skip: false }
  }
}
