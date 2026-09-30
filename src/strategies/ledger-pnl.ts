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
}

export function summarizeLedger(positions: LedgerPosition[]): LedgerSummary {
  const closed = positions.filter((p) => p.closed)
  const grossWinSol = closed.filter((p) => p.pnlSol > 0).reduce((s, p) => s + p.pnlSol, 0)
  const grossLossSol = closed.filter((p) => p.pnlSol < 0).reduce((s, p) => s + p.pnlSol, 0)
  const realizedCost = closed.reduce((s, p) => s + p.costSol, 0)
  const realizedPnlSol = grossWinSol + grossLossSol
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
  }
}
