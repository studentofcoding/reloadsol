import { cacheGet, cacheSet } from '@/utils/redis-cache'

export const SPINE_TICK_CAP = 50
const TTL_SEC = 60 * 60 * 24

export type SpineDecision = {
  workerId: string
  mint: string
  symbol?: string
  stage: 'gate' | 'price' | 'rug' | 'size' | 'pass'
  reason: string | null
  passed: boolean
  p: number | null
  solAmount: number | null
  takeProfitPct: number | null
  stopLossPct: number | null
  at: string
}

export function spineTickKey(workerId: string): string {
  return `spine:tick:${workerId}`
}

export function pushSpineDecision(
  prev: SpineDecision[],
  next: SpineDecision,
): SpineDecision[] {
  return [...prev, next].slice(-SPINE_TICK_CAP)
}

export async function readSpineDecisions(
  workerId: string,
): Promise<SpineDecision[]> {
  const rows = await cacheGet<SpineDecision[]>(spineTickKey(workerId))
  return Array.isArray(rows) ? rows : []
}

export async function appendSpineDecision(
  decision: SpineDecision,
): Promise<void> {
  const prev = await readSpineDecisions(decision.workerId)
  await cacheSet(
    spineTickKey(decision.workerId),
    pushSpineDecision(prev, decision),
    TTL_SEC,
  )
}

export function spinePassDecision(
  workerId: string,
  mint: string,
  symbol: string | undefined,
  pass: {
    p: number
    solAmount: number
    takeProfitPct: number
    stopLossPct: number
  },
): SpineDecision {
  return {
    workerId,
    mint,
    symbol,
    stage: 'pass',
    reason: null,
    passed: true,
    p: pass.p,
    solAmount: pass.solAmount,
    takeProfitPct: pass.takeProfitPct,
    stopLossPct: pass.stopLossPct,
    at: new Date().toISOString(),
  }
}

export function spineSkipDecision(
  workerId: string,
  mint: string,
  stage: SpineDecision['stage'],
  reason: string,
  symbol?: string,
): SpineDecision {
  return {
    workerId,
    mint,
    symbol,
    stage,
    reason,
    passed: false,
    p: null,
    solAmount: null,
    takeProfitPct: null,
    stopLossPct: null,
    at: new Date().toISOString(),
  }
}
