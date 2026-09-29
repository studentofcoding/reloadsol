/**
 * Fire-and-forget queue for the shadow risk writer.
 *
 * The shadow is best-effort and display-only, so it must never sit inline on a
 * latency-sensitive path (mcap sim-open, trending cycle). Callers enqueue and
 * return; a single serial drain does the work, which also lets the per-upstream
 * gates (RugCheck 3 rps, GMGN max-req) pace it for free.
 *
 * Deduped by (chain, token) while queued/in-flight and bounded so a burst cannot
 * grow memory or stampede upstream. Drops are silent — this is telemetry, not a
 * correctness path.
 */

import {
  attachRiskShadow,
  type RiskShadowResult,
} from '@/strategies/risk-store'
import { isRugcheckEnabled } from '@/utils/rugcheck-api'
import { isDevReputationEnabled } from '@/utils/dev-reputation-data'

export type RiskShadowJob = {
  chain: string
  tokenAddress: string
  info?: Record<string, unknown>
}

const MAX_QUEUE = 300

const queue: Array<RiskShadowJob & { key: string }> = []
const inflight = new Set<string>()
let draining = false

function keyOf(job: RiskShadowJob): string {
  return `${job.chain}:${job.tokenAddress.trim()}`
}

export function riskShadowQueueSize(): number {
  return queue.length
}

/** Enqueue a token for shadow evaluation. Never throws, never awaits work. */
export function enqueueRiskShadow(job: RiskShadowJob): void {
  if (!isRugcheckEnabled() && !isDevReputationEnabled()) return
  const address = job.tokenAddress.trim()
  if (!address) return

  const key = keyOf({ ...job, tokenAddress: address })
  if (inflight.has(key) || queue.some((j) => j.key === key)) return
  if (queue.length >= MAX_QUEUE) return

  queue.push({ chain: job.chain, tokenAddress: address, info: job.info, key })
  void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (;;) {
      const job = queue.shift()
      if (!job) break
      inflight.add(job.key)
      try {
        await attachRiskShadow({
          chain: job.chain,
          tokenAddress: job.tokenAddress,
          info: job.info ?? {},
        })
      } catch {
        // best-effort — never surface a shadow failure
      } finally {
        inflight.delete(job.key)
      }
    }
  } finally {
    draining = false
  }
}

/** Test-only: drop queued/in-flight state. */
export function __resetRiskShadowQueueForTests(): void {
  queue.length = 0
  inflight.clear()
  draining = false
}

/** Test-only: inspect the last drain result count. */
export type { RiskShadowResult }
