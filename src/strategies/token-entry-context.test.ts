import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))
vi.mock('@/utils/jupiter-metadata', () => ({ fetchJupiterMarketHints: vi.fn() }))

import {
  entryContextBarCount,
  freezeEntryContext,
  isEntryContextEnabled,
  toEntryBars,
  type EntryContextInput,
} from './token-entry-context'

const MINT = 'So11111111111111111111111111111111111111112'
const DETECTED = new Date('2026-10-04T03:00:00.000Z')
const INPUT: EntryContextInput = {
  chain: 'sol',
  tokenAddress: MINT,
  detectingStrategy: 'mcap_enter_first_seen',
  source: 'mcap_first_seen',
  detectedAt: DETECTED,
}
const ON = { ENTRY_CONTEXT_FREEZE: '1' }

type Handler = (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>
function fakeQuery(handler: Handler) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const q = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    return handler(sql, params)
  })
  return { q: q as never, calls }
}

const happy: Handler = (sql) => {
  if (sql.includes('FROM token_entry_context')) return { rows: [] }
  if (sql.includes('FROM token_mcap_tracking'))
    return { rows: [{ first_mcap: '40000', current_mcap: 52000, first_seen_at: '2026-10-04T02:58:00.000Z', label: 'rising' }] }
  if (sql.includes('FROM token_info_detect'))
    return {
      rows: [
        {
          detected_at: '2026-10-04T03:00:01.000Z',
          detecting_strategy: 'mcap_enter_first_seen',
          source: 'mcap_first_seen',
          top10_hold_pct: 22.5,
          dev_hold_pct: 1,
          snipers_hold_pct: null,
          sniper_wallet_count: 4,
          freeze_auth_active: false,
          mint_auth_active: false,
          dex_boost_label: null,
          pro_traders_pct: 3,
          insiders_hold_pct: 0,
          bundlers_hold_pct: 2,
        },
      ],
    }
  if (sql.includes('FROM token_ohlc_bars'))
    return {
      rows: [
        { timestamp: new Date('2026-10-04T02:59:00Z'), open: '2', high: '3', low: '1', close: '2.5', volume: null },
        { timestamp: new Date('2026-10-04T02:58:00Z'), open: '1', high: '2', low: '1', close: '2', volume: '10' },
      ],
    }
  if (sql.startsWith('\nINSERT INTO token_entry_context')) return { rows: [{ id: 'x' }] }
  return { rows: [] }
}

beforeEach(() => vi.clearAllMocks())

describe('flags', () => {
  it('is off unless ENTRY_CONTEXT_FREEZE=1', () => {
    expect(isEntryContextEnabled({})).toBe(false)
    expect(isEntryContextEnabled(ON)).toBe(true)
  })
  it('clamps the bar count', () => {
    expect(entryContextBarCount({})).toBe(30)
    expect(entryContextBarCount({ ENTRY_CONTEXT_BARS: '9999' })).toBe(240)
    expect(entryContextBarCount({ ENTRY_CONTEXT_BARS: '-3' })).toBe(30)
  })
})

describe('freezeEntryContext', () => {
  it('does nothing (not even a query) while disabled', async () => {
    const { q, calls } = fakeQuery(happy)
    const jupiter = vi.fn()
    const res = await freezeEntryContext(INPUT, { query: q, jupiter, env: {} })
    expect(res).toEqual({ inserted: false, reason: 'disabled' })
    expect(calls).toHaveLength(0)
    expect(jupiter).not.toHaveBeenCalled()
  })

  it('ignores non-Sol chains', async () => {
    const { q, calls } = fakeQuery(happy)
    const res = await freezeEntryContext({ ...INPUT, chain: 'robinhood' as never }, { query: q, env: ON })
    expect(res).toEqual({ inserted: false, reason: 'not_sol' })
    expect(calls).toHaveLength(0)
  })

  it('does no upstream work when a row already exists (first writer wins)', async () => {
    const { q, calls } = fakeQuery((sql) => (sql.includes('FROM token_entry_context') ? { rows: [{ one: 1 }] } : { rows: [] }))
    const jupiter = vi.fn()
    const res = await freezeEntryContext(INPUT, { query: q, jupiter, env: ON })
    expect(res).toEqual({ inserted: false, reason: 'exists' })
    expect(calls).toHaveLength(1)
    expect(jupiter).not.toHaveBeenCalled()
  })

  it('freezes tracker + Jupiter + tiles + pre-entry bars (oldest first, strictly before detect)', async () => {
    const { q, calls } = fakeQuery(happy)
    const jupiter = vi.fn(async () => ({ usdPrice: 0.0001, volume5m: 1234, mcap: 61000, volumeWindow: '5m' as const }))
    const now = new Date('2026-10-04T03:00:07.000Z')
    const res = await freezeEntryContext(INPUT, { query: q, jupiter, now: () => now, env: ON })
    expect(res).toEqual({ inserted: true })

    const barsCall = calls.find((c) => c.sql.includes('FROM token_ohlc_bars'))!
    expect(barsCall.sql).toContain('timestamp < $2')
    expect(barsCall.params).toEqual([MINT, DETECTED.toISOString(), 30])

    const insert = calls.find((c) => c.sql.includes('INSERT INTO token_entry_context'))!
    const p = insert.params
    expect(p[0]).toBe('sol')
    expect(p[2]).toBe(DETECTED.toISOString())
    expect(p[5]).toBe(7000) // capture_lag_ms
    expect(p.slice(6, 11)).toEqual([40000, 52000, '2026-10-04T02:58:00.000Z', 'rising', 'ok'])
    expect(p.slice(11, 16)).toEqual([61000, 0.0001, 1234, now.toISOString(), 'ok'])
    const info = JSON.parse(p[16] as string)
    expect(info).toMatchObject({ top10HoldPct: 22.5, sniperWalletCount: 4, freezeAuthActive: false, snipersHoldPct: null })
    expect(p[17]).toBe('ledger')
    const bars = JSON.parse(p[18] as string)
    expect(bars.map((b: { t: string }) => b.t)).toEqual(['2026-10-04T02:58:00.000Z', '2026-10-04T02:59:00.000Z'])
    expect(bars[0]).toMatchObject({ o: 1, c: 2, v: 10 })
    expect(p[19]).toBe(2)
    expect(p[20]).toBe('2026-10-04T02:59:00.000Z')
  })

  it('still freezes when Jupiter times out, and records why', async () => {
    const { q, calls } = fakeQuery(happy)
    const jupiter = vi.fn(() => new Promise<never>(() => {}))
    const res = await freezeEntryContext(INPUT, {
      query: q,
      jupiter,
      env: { ...ON, ENTRY_CONTEXT_JUPITER_TIMEOUT_MS: '10' },
    })
    expect(res).toEqual({ inserted: true })
    const p = calls.find((c) => c.sql.includes('INSERT INTO token_entry_context'))!.params
    expect(p.slice(11, 16)).toEqual([null, null, null, null, 'timeout'])
  })

  it('makes no Jupiter call when ENTRY_CONTEXT_JUPITER=off', async () => {
    const { q, calls } = fakeQuery(happy)
    const jupiter = vi.fn()
    await freezeEntryContext(INPUT, { query: q, jupiter, env: { ...ON, ENTRY_CONTEXT_JUPITER: 'off' } })
    expect(jupiter).not.toHaveBeenCalled()
    expect(calls.find((c) => c.sql.includes('INSERT INTO token_entry_context'))!.params[15]).toBe('disabled')
  })

  it('records a failed tracker read as status=error instead of dropping the freeze', async () => {
    const { q, calls } = fakeQuery((sql, params) => {
      if (sql.includes('FROM token_mcap_tracking')) throw new Error('boom')
      return happy(sql, params)
    })
    const res = await freezeEntryContext(INPUT, { query: q, jupiter: vi.fn(async () => null), env: ON })
    expect(res).toEqual({ inserted: true })
    const p = calls.find((c) => c.sql.includes('INSERT INTO token_entry_context'))!.params
    expect(p[10]).toBe('error')
    expect(p[15]).toBe('unavailable')
  })

  it('reports a lost insert race as exists', async () => {
    const { q } = fakeQuery((sql, params) => (sql.includes('INSERT INTO token_entry_context') ? { rows: [] } : happy(sql, params)))
    await expect(freezeEntryContext(INPUT, { query: q, jupiter: vi.fn(async () => null), env: ON })).resolves.toEqual({
      inserted: false,
      reason: 'exists',
    })
  })

  it('never rejects on a DB failure', async () => {
    const { q } = fakeQuery(() => {
      throw new Error('db down')
    })
    await expect(freezeEntryContext(INPUT, { query: q, env: ON })).resolves.toEqual({ inserted: false, reason: 'error' })
  })

  it('collapses concurrent freezes of the same mint', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { q } = fakeQuery(async (sql, params) => {
      if (sql.includes('FROM token_entry_context')) await gate
      return happy(sql, params)
    })
    const first = freezeEntryContext(INPUT, { query: q, jupiter: vi.fn(async () => null), env: ON })
    const second = await freezeEntryContext(INPUT, { query: q, jupiter: vi.fn(async () => null), env: ON })
    expect(second).toEqual({ inserted: false, reason: 'in_flight' })
    release()
    await first
  })
})

describe('toEntryBars', () => {
  it('reverses newest-first rows and tolerates null volume', () => {
    const bars = toEntryBars([
      { timestamp: '2026-10-04T02:59:00Z', open: 2, high: 3, low: 1, close: 2, volume: null },
      { timestamp: '2026-10-04T02:58:00Z', open: 1, high: 1, low: 1, close: 1, volume: 5 },
    ])
    expect(bars.map((b) => b.t)).toEqual(['2026-10-04T02:58:00.000Z', '2026-10-04T02:59:00.000Z'])
    expect(bars[1].v).toBeNull()
  })
})
