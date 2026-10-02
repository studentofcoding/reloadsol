import { describe, expect, it } from 'vitest'
import {
  buildTokenPnlCsv,
  dayInTimeZone,
  isValidDayString,
  pnlSol,
  summarizeTokens,
  toNum,
  tokenPnlFileName,
  topTokens,
  worstTokens,
  type TokenPnlRow,
} from './token-pnl-export'

function token(over: Partial<TokenPnlRow> = {}): TokenPnlRow {
  return {
    tokenAddress: 'So11111111111111111111111111111111111111112',
    symbol: 'TOK',
    strategies: ['att_rh'],
    trades: 3,
    won: 2,
    lost: 1,
    priced: 3,
    sumPnlPct: 100,
    avgPnlPct: 33.33,
    medianPnlPct: 10,
    firstEntry: '2026-09-29T01:00:00Z',
    lastExit: '2026-09-29T02:00:00Z',
    ...over,
  }
}

describe('pnlSol', () => {
  it('scales a summed pnl_pct by the per-position size', () => {
    // The 2026-09-29 window: sum(pnl_pct) = 26,676 at 0.005 SOL per position.
    expect(pnlSol(26676, 0.005)).toBeCloseTo(1.3338, 6)
  })

  it('is zero for a flat window and negative for a losing one', () => {
    expect(pnlSol(0, 0.005)).toBe(0)
    expect(pnlSol(-3357.5, 0.005)).toBeCloseTo(-0.167875, 6)
  })
})

describe('toNum', () => {
  it('coerces pg numeric strings, which arrive as strings', () => {
    expect(toNum('26676.0')).toBe(26676)
    expect(toNum(12.5)).toBe(12.5)
  })

  it('treats null/undefined/empty/junk as zero rather than NaN', () => {
    for (const v of [null, undefined, '', 'abc', NaN, Infinity]) {
      expect(toNum(v)).toBe(0)
    }
  })
})

describe('summarizeTokens', () => {
  it('sums the token rows rather than trusting a passed-in total', () => {
    const s = summarizeTokens({
      tokens: [token({ sumPnlPct: 100 }), token({ sumPnlPct: -40 }), token({ sumPnlPct: 25 })],
      trades: 9,
      won: 5,
      lost: 4,
      priced: 9,
      avgPnlPct: 10,
      medianPnlPct: 1,
      grossWinPct: 125,
      grossLossPct: -40,
      peakConcurrent: 4,
      positionSizeSol: 0.005,
    })
    expect(s.sumPnlPct).toBe(85)
    expect(s.tokens).toBe(3)
    expect(s.pnlSol).toBeCloseTo(0.00425, 8)
    expect(s.peakCapitalSol).toBeCloseTo(0.02, 8)
    expect(s.profitFactor).toBeCloseTo(125 / 40, 6)
  })

  it('reports a null profit factor when nothing lost, instead of dividing by zero', () => {
    const s = summarizeTokens({
      tokens: [token()],
      trades: 1,
      won: 1,
      lost: 0,
      priced: 1,
      avgPnlPct: 50,
      medianPnlPct: 50,
      grossWinPct: 50,
      grossLossPct: 0,
      peakConcurrent: 1,
      positionSizeSol: 0.005,
    })
    expect(s.profitFactor).toBeNull()
  })

  it('measures concentration as the top-N tokens share of gross wins', () => {
    const tokens = [
      token({ symbol: 'A', sumPnlPct: 100 }),
      token({ symbol: 'B', sumPnlPct: 60 }),
      token({ symbol: 'C', sumPnlPct: -30 }),
      token({ symbol: 'D', sumPnlPct: 40 }),
    ]
    const s = summarizeTokens({
      tokens,
      trades: 4,
      won: 3,
      lost: 1,
      priced: 4,
      avgPnlPct: 42.5,
      medianPnlPct: 50,
      grossWinPct: 200,
      grossLossPct: -30,
      peakConcurrent: 2,
      positionSizeSol: 0.005,
      concentrationTop: 2,
    })
    // Top two tokens (A 100, B 60) out of 200 gross win points.
    expect(s.topSharePct).toBeCloseTo(80, 6)
    expect(s.concentrationTop).toBe(2)
  })

  it('never lets a negative token inflate the concentration numerator', () => {
    const s = summarizeTokens({
      tokens: [token({ sumPnlPct: 10 }), token({ sumPnlPct: -5 })],
      trades: 2,
      won: 1,
      lost: 1,
      priced: 2,
      avgPnlPct: 2.5,
      medianPnlPct: 2.5,
      grossWinPct: 10,
      grossLossPct: -5,
      peakConcurrent: 2,
      positionSizeSol: 0.005,
      concentrationTop: 5,
    })
    expect(s.topSharePct).toBeCloseTo(100, 6)
  })
})

describe('topTokens / worstTokens', () => {
  const tokens = [
    token({ symbol: 'mid', sumPnlPct: 10 }),
    token({ symbol: 'best', sumPnlPct: 900 }),
    token({ symbol: 'worst', sumPnlPct: -80 }),
    token({ symbol: 'good', sumPnlPct: 40 }),
  ]

  it('returns the n best and n worst, sorted', () => {
    expect(topTokens(tokens, 2).map((t) => t.symbol)).toEqual(['best', 'good'])
    expect(worstTokens(tokens, 2).map((t) => t.symbol)).toEqual(['worst', 'mid'])
  })

  it('caps at the available tokens and leaves the input untouched', () => {
    const before = tokens.map((t) => t.symbol)
    expect(topTokens(tokens, 10)).toHaveLength(4)
    expect(tokens.map((t) => t.symbol)).toEqual(before)
  })
})

describe('buildTokenPnlCsv', () => {
  const tokens = Array.from({ length: 4 }, (_, i) =>
    token({ symbol: `S${i}`, tokenAddress: `addr${i}`, sumPnlPct: 100 - i * 40 }),
  )
  const summary = summarizeTokens({
    tokens,
    trades: 12,
    won: 6,
    lost: 6,
    priced: 12,
    avgPnlPct: 30,
    medianPnlPct: 0,
    grossWinPct: 160,
    grossLossPct: -100,
    peakConcurrent: 5,
    positionSizeSol: 0.005,
    concentrationTop: 2,
  })

  function csv() {
    return buildTokenPnlCsv({
      summary,
      tokens,
      positionSizeSol: 0.005,
      from: '2026-09-27',
      to: '2026-09-30',
      timeZone: 'Asia/Bangkok',
      generatedAt: '2026-09-30T00:00:00Z',
    })
  }

  it('carries the range, timezone and position size in the metadata block', () => {
    const text = csv()
    expect(text).toContain('# range,2026-09-27..2026-09-30')
    expect(text).toContain('# timezone,Asia/Bangkok')
    expect(text).toContain('# position_size_sol,0.005')
    // Token sums: 100 + 60 + 20 - 20 = 160 points at 0.005 SOL per position.
    expect(text).toContain('# pnl_sol,0.008')
    expect(text).toContain('# peak_concurrent,5')
    expect(text).toContain('# peak_capital_sol,0.025')
  })

  it('lists the chains and warns when the notional column mixes native units', () => {
    const single = buildTokenPnlCsv({
      summary,
      tokens,
      positionSizeSol: 0.005,
      from: '2026-09-27',
      to: '2026-09-30',
      timeZone: 'Asia/Bangkok',
      chains: ['sol'],
    })
    expect(single).toContain('# chains,sol')
    expect(single).not.toContain('units_note')

    const mixed = buildTokenPnlCsv({
      summary,
      tokens,
      positionSizeSol: 0.005,
      from: '2026-09-27',
      to: '2026-09-30',
      timeZone: 'Asia/Bangkok',
      chains: ['robinhood', 'sol'],
    })
    expect(mixed).toContain('# chains,robinhood|sol')
    expect(mixed).toContain('units_note')
  })

  it('emits winner, loser and full sections with ranks', () => {
    const lines = csv().split('\n')
    const rows = lines.slice(lines.findIndex((l) => l.startsWith('"section"')))
    const winners = rows.filter((l) => l.startsWith('"winner"'))
    const losers = rows.filter((l) => l.startsWith('"loser"'))
    const all = rows.filter((l) => l.startsWith('"all"'))

    expect(winners).toHaveLength(4)
    expect(losers).toHaveLength(4)
    expect(all).toHaveLength(4)
    expect(winners[0]).toContain('"S0"')
    expect(losers[0]).toContain('"S3"')
    expect(winners[0].startsWith('"winner","1"')).toBe(true)
  })

  it('writes the per-token pnl_sol from the position size', () => {
    const winners = csv()
      .split('\n')
      .filter((l) => l.startsWith('"winner"'))
    // First token: +100 points at 0.005 SOL => 0.005 SOL.
    expect(winners[0]).toContain('"0.005"')
  })

  it('quotes and escapes hostile symbols so the columns survive', () => {
    const text = buildTokenPnlCsv({
      summary,
      tokens: [token({ symbol: 'A,B "quoted" C', sumPnlPct: 5 })],
      positionSizeSol: 0.005,
      from: '2026-09-29',
      to: '2026-09-30',
      timeZone: 'Asia/Bangkok',
    })
    expect(text).toContain('"A,B ""quoted"" C"')
  })

  it('handles a missing symbol without dropping the row', () => {
    const text = buildTokenPnlCsv({
      summary,
      tokens: [token({ symbol: '', sumPnlPct: 5 })],
      positionSizeSol: 0.005,
      from: '2026-09-29',
      to: '2026-09-30',
      timeZone: 'Asia/Bangkok',
    })
    const all = text.split('\n').filter((l) => l.startsWith('"all"'))
    expect(all).toHaveLength(1)
    expect(all[0]).toContain('""')
  })
})

describe('tokenPnlFileName', () => {
  it('names the file after the exported range', () => {
    expect(tokenPnlFileName('2026-09-27', '2026-09-30')).toBe(
      'token-pnl_2026-09-27_to_2026-09-30.csv',
    )
  })
})

describe('isValidDayString', () => {
  it('accepts real days and rejects anything else', () => {
    expect(isValidDayString('2026-09-29')).toBe(true)
    expect(isValidDayString('2026-02-29')).toBe(false) // 2026 is not a leap year
    expect(isValidDayString('2026-13-01')).toBe(false)
    expect(isValidDayString('2026-09-31')).toBe(false)
    expect(isValidDayString('29-09-2026')).toBe(false)
    expect(isValidDayString('2026-09-29T00:00:00Z')).toBe(false)
    expect(isValidDayString('')).toBe(false)
  })
})

describe('dayInTimeZone', () => {
  it('anchors the calendar day to the report timezone, not UTC', () => {
    // 2026-09-29T18:00Z is already 2026-09-30 in Asia/Bangkok (+07).
    const moment = new Date('2026-09-29T18:00:00Z')
    expect(dayInTimeZone(moment, 'Asia/Bangkok')).toBe('2026-09-30')
    expect(dayInTimeZone(moment, 'UTC')).toBe('2026-09-29')
  })

  it('formats as a zero-padded YYYY-MM-DD that the route can pass to SQL', () => {
    const day = dayInTimeZone(new Date('2026-01-05T03:00:00Z'), 'Asia/Bangkok')
    expect(day).toBe('2026-01-05')
    expect(isValidDayString(day)).toBe(true)
  })
})

describe('buildTokenPnlCsv concentration metadata', () => {
  it('reports the top-N share using the configured concentration window', () => {
    const tokens = [
      token({ symbol: 'big', sumPnlPct: 900 }),
      token({ symbol: 'small', sumPnlPct: 100 }),
    ]
    const c = 1
    const summary = summarizeTokens({
      tokens,
      trades: 2,
      won: 2,
      lost: 0,
      priced: 2,
      avgPnlPct: 500,
      medianPnlPct: 500,
      grossWinPct: 1000,
      grossLossPct: 0,
      peakConcurrent: 2,
      positionSizeSol: 0.005,
      concentrationTop: c,
    })
    const text = buildTokenPnlCsv({
      summary,
      tokens,
      positionSizeSol: 0.005,
      from: '2026-09-29',
      to: '2026-09-29',
      timeZone: 'Asia/Bangkok',
      topN: c,
    })
    expect(text).toContain('# top1_share_of_wins_pct,90')
    expect(text).toContain('# pnl_sol,0.05')
  })
})
