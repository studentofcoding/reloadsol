/**
 * Read-side PnL from the sim LEDGER (`trading_records`), rather than from the outcome row.
 *
 * Why this exists, after four failed attempts to record an execution fill inside the outcome writer:
 * the ledger already holds what actually happened — every simulated buy and sell with its own SOL
 * amount and token amount — so the realized result can be *derived* rather than enriched at write
 * time. A computation that runs in a query is visible when it breaks; one that runs inside an
 * outcome insert fails silently, which is exactly what happened (a guard that could not be observed
 * from outside).
 *
 * Semantics mirror the sims' own reconstruction (`computeOpenTradeCycle`): a position is scoped per
 * (strategy, mint); buys accumulate cost, sells accumulate proceeds, and a position whose remaining
 * token amount reaches zero is closed. The next buy starts a new cycle, so a re-entry is a separate
 * position rather than a bigger one.
 *
 * Amounts are in the chain's native unit (SOL for sol, ETH for the Robinhood twin) — never summed
 * across chains.
 */
import {
  computeBuyFill,
  computeSellFill,
  resolveDepth,
  resolveExecutionParams,
  type ExecutionParams,
} from './execution-model'
import type { TrackingRecord } from '@/utils/trading-tracker'

export interface LedgerPosition {
  strategyId: string | null
  mintAddress: string
  symbol: string | null
  chain: string
  costSol: number
  proceedsSol: number
  pnlSol: number
  pnlPct: number
  buys: number
  sells: number
  openedAt: number
  closedAt: number | null
  closed: boolean
}

interface Working {
  strategyId: string | null
  mintAddress: string
  symbol: string | null
  chain: string
  costSol: number
  proceedsSol: number
  tokensIn: number
  tokensOut: number
  buys: number
  sells: number
  openedAt: number
}

function recordStrategy(record: TrackingRecord): string | null {
  const raw = (record as unknown as { bot_strategy?: unknown }).bot_strategy
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function tokenSol(record: TrackingRecord, mintAddress: string): number {
  const token = (record.tokens ?? []).find((t) => t.mintAddress === mintAddress)
  const perToken = Number(token?.solAmount)
  if (Number.isFinite(perToken) && perToken > 0) return perToken
  // Fall back to the record total spread over its successes, as the sims do.
  const total = Number(record.solAmount)
  const successes = Number(record.successCount) || 1
  return Number.isFinite(total) && total > 0 ? total / successes : 0
}

function tokenAmount(record: TrackingRecord, mintAddress: string): number {
  const token = (record.tokens ?? []).find((t) => t.mintAddress === mintAddress)
  const amount = Number(token?.tokenAmount)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

function toPosition(w: Working, closedAt: number | null): LedgerPosition {
  const pnlSol = w.proceedsSol - w.costSol
  return {
    strategyId: w.strategyId,
    mintAddress: w.mintAddress,
    symbol: w.symbol,
    chain: w.chain,
    costSol: w.costSol,
    proceedsSol: w.proceedsSol,
    pnlSol,
    pnlPct: w.costSol > 0 ? (pnlSol / w.costSol) * 100 : 0,
    buys: w.buys,
    sells: w.sells,
    openedAt: w.openedAt,
    closedAt,
    closed: closedAt !== null,
  }
}

/**
 * Walk the ledger and return one entry per (strategy, mint) position. Pure: same records in, same
 * positions out, no clock and no network.
 */
export function summarizeLedgerPositions(records: TrackingRecord[]): LedgerPosition[] {
  const sorted = [...records]
    .filter((r) => r?.is_simulation !== false)
    .sort((a, b) => a.timestamp - b.timestamp)

  const open = new Map<string, Working>()
  const done: LedgerPosition[] = []

  for (const record of sorted) {
    if (record.successCount === 0) continue
    const strategyId = recordStrategy(record)
    const chain = record.chain ?? 'sol'

    for (const token of record.tokens ?? []) {
      const mintAddress = token?.mintAddress
      if (!mintAddress) continue
      const key = `${strategyId ?? '-'}::${mintAddress}`

      if (record.operationType === 'buy') {
        const existing = open.get(key)
        const working: Working =
          existing ??
          {
            strategyId,
            mintAddress,
            symbol: token.symbol ?? null,
            chain,
            costSol: 0,
            proceedsSol: 0,
            tokensIn: 0,
            tokensOut: 0,
            buys: 0,
            sells: 0,
            openedAt: record.timestamp,
          }
        working.costSol += tokenSol(record, mintAddress)
        working.tokensIn += tokenAmount(record, mintAddress)
        working.buys += 1
        if (!working.symbol && token.symbol) working.symbol = token.symbol
        open.set(key, working)
        continue
      }

      // A sell or a close. Sells without an open cycle are ignored: they belong to a position that
      // started before this window, and counting them would show proceeds with no cost.
      const working = open.get(key)
      if (!working) continue
      working.proceedsSol += tokenSol(record, mintAddress)
      working.tokensOut += tokenAmount(record, mintAddress)
      working.sells += 1

      const remaining = working.tokensIn - working.tokensOut
      const fullyClosed =
        record.operationType === 'close' ||
        (working.tokensIn > 0 && remaining <= working.tokensIn * 1e-6)
      if (fullyClosed) {
        done.push(toPosition(working, record.timestamp))
        open.delete(key)
      }
    }
  }

  // Still-open positions are returned too, flagged, with no close time.
  for (const working of open.values()) {
    done.push(toPosition(working, null))
  }

  return done.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt))
}

/**
 * The execution model's round-trip cost for a position of this size, at the assumed depth.
 *
 * Applied read-side, so the ledger view can show realized (as recorded) and modelled-net (after
 * slippage, impact, fees and priority cost) side by side — without touching any write path.
 */
export function modelledDragSol(costSol: number, params?: ExecutionParams): number {
  if (!(costSol > 0)) return 0
  const exec = params ?? resolveExecutionParams()
  const depth = resolveDepth({}, exec)
  const entry = computeBuyFill({ side: 'buy', spotPrice: 1, notionalQuote: costSol, depth, params: exec })
  const exit = computeSellFill({
    side: 'sell',
    spotPrice: 1,
    notionalQuote: 0,
    depth,
    params: exec,
    tokenAmount: entry.tokens,
  })
  // A flat round trip is a pure cost: what goes in minus what comes back.
  return Math.max(0, entry.costQuote - exit.proceedsQuote)
}

export interface LedgerSummary {
  positions: number
  closed: number
  open: number
  costSol: number
  proceedsSol: number
  pnlSol: number
  /** Realized only: the closed positions, which is what "PnL" usually means. */
  realizedPnlSol: number
  realizedPnlPct: number
  won: number
  lost: number
  winRatePct: number
  grossWinSol: number
  grossLossSol: number
  profitFactor: number | null
  /** Sum of the modelled execution cost across the positions counted above. */
  modelledDragSol: number
  /** Realized minus modelled drag: what the same trades would net after slippage and impact. */
  realizedNetSol: number
}

export function summarizeLedger(positions: LedgerPosition[]): LedgerSummary {
  const closed = positions.filter((p) => p.closed)
  const grossWinSol = closed.filter((p) => p.pnlSol > 0).reduce((s, p) => s + p.pnlSol, 0)
  const grossLossSol = closed.filter((p) => p.pnlSol < 0).reduce((s, p) => s + p.pnlSol, 0)
  const realizedCost = closed.reduce((s, p) => s + p.costSol, 0)
  const realizedPnlSol = grossWinSol + grossLossSol
  const drag = closed.reduce((s, p) => s + modelledDragSol(p.costSol), 0)
  return {
    positions: positions.length,
    closed: closed.length,
    open: positions.length - closed.length,
    costSol: positions.reduce((s, p) => s + p.costSol, 0),
    proceedsSol: positions.reduce((s, p) => s + p.proceedsSol, 0),
    pnlSol: positions.reduce((s, p) => s + p.pnlSol, 0),
    realizedPnlSol,
    realizedPnlPct: realizedCost > 0 ? (realizedPnlSol / realizedCost) * 100 : 0,
    won: closed.filter((p) => p.pnlSol > 0).length,
    lost: closed.filter((p) => p.pnlSol < 0).length,
    winRatePct: closed.length > 0 ? (closed.filter((p) => p.pnlSol > 0).length / closed.length) * 100 : 0,
    grossWinSol,
    grossLossSol,
    profitFactor: grossLossSol < 0 ? grossWinSol / Math.abs(grossLossSol) : null,
    modelledDragSol: drag,
    realizedNetSol: realizedPnlSol - drag,
  }
}

// --- per-strategy readiness: what a live candidate has to clear ------------------------------------
//
// The decision this answers: is a strategy worth arming, judged at a size and a cost we would actually
// trade? Everything here is measured from the positions — no headline means (one 5,000% winner carries a
// mean), no gross-only numbers (a positive gross with a drag that eats it is not a candidate), and no
// aggregate that hides which strategy is which.

export interface StrategyReadiness {
  strategyId: string
  /** Closed positions in the window. */
  closed: number
  /** Median return per trade. The typical trade, not the average one. */
  medianPnlPct: number
  /** Median stake, which is what decides how much the fixed cost bites. */
  medianSizeSol: number
  grossSol: number
  dragSol: number
  netSol: number
  netPerTradeSol: number
  /** Peak simultaneous open positions — must fit `MAX_SOL_AT_RISK` at the live size. */
  peakConcurrent: number
  verdict: 'candidate' | 'marginal' | 'not_viable'
}

/** Maximum simultaneous open positions from interval overlap (openedAt → closedAt). */
export function peakConcurrentPositions(positions: LedgerPosition[]): number {
  const events: Array<{ at: number; delta: number }> = []
  for (const p of positions) {
    events.push({ at: p.openedAt, delta: 1 })
    // An open position never releases; a closed one releases at its close.
    if (p.closed && p.closedAt != null) events.push({ at: p.closedAt, delta: -1 })
  }
  // Closes before opens at the same instant, so touching intervals are not counted as overlapping.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let live = 0
  let peak = 0
  for (const e of events) {
    live += e.delta
    if (live > peak) peak = live
  }
  return peak
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function buildStrategyReadiness(
  positions: LedgerPosition[],
  params?: ExecutionParams,
): StrategyReadiness[] {
  const byStrategy = new Map<string, LedgerPosition[]>()
  for (const p of positions) {
    const key = p.strategyId ?? '(unknown)'
    const list = byStrategy.get(key)
    if (list) list.push(p)
    else byStrategy.set(key, [p])
  }

  const out: StrategyReadiness[] = []
  for (const [strategyId, list] of byStrategy) {
    const closedPositions = list.filter((p) => p.closed)
    if (closedPositions.length === 0) continue
    const grossSol = closedPositions.reduce((s, p) => s + p.pnlSol, 0)
    // The calibrated model, not an approximation: the same drag the ledger summary applies.
    const dragSol = closedPositions.reduce((s, p) => s + modelledDragSol(p.costSol, params), 0)
    const netSol = grossSol - dragSol
    const netPerTradeSol = netSol / closedPositions.length
    const medianPnlPct = median(closedPositions.map((p) => p.pnlPct).sort((a, b) => a - b))
    const medianSizeSol = median(closedPositions.map((p) => p.costSol).sort((a, b) => a - b))

    out.push({
      strategyId,
      closed: closedPositions.length,
      medianPnlPct,
      medianSizeSol,
      grossSol,
      dragSol,
      netSol,
      netPerTradeSol,
      peakConcurrent: peakConcurrentPositions(list),
      // A candidate is one whose typical trade is positive *and* whose total survives the drag. Below
      // that it is not a sizing question — no size fixes a median that loses to its own fixed cost.
      verdict:
        netPerTradeSol > 0 && medianPnlPct > 0
          ? 'candidate'
          : netPerTradeSol > 0
            ? 'marginal'
            : 'not_viable',
    })
  }
  return out.sort((a, b) => b.netPerTradeSol - a.netPerTradeSol)
}
