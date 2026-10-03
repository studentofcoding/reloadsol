import { describe, expect, it } from 'vitest'
import { resolveJupiterMaxRps } from './jupiter-rps'

describe('resolveJupiterMaxRps', () => {
  it('defaults to the measured-clean rate, not a hopeful one', () => {
    // 0.5 rps paced was measured 10/10 clean (p50 260ms) while sharing the key with live traffic;
    // ~6 rps bursts and any concurrency are rejected outright. A missing env var must not change that.
    expect(resolveJupiterMaxRps({})).toBe(0.5)
  })

  it('takes an explicit rate, including one below the quota', () => {
    expect(resolveJupiterMaxRps({ JUPITER_MAX_RPS: '0.3' })).toBe(0.3)
    expect(resolveJupiterMaxRps({ JUPITER_MAX_RPS: '1' })).toBe(1)
  })

  it('refuses junk and non-positive values rather than disabling the gate', () => {
    for (const raw of ['', 'abc', '0', '-2', 'NaN', 'Infinity']) {
      expect(resolveJupiterMaxRps({ JUPITER_MAX_RPS: raw })).toBe(0.5)
    }
  })
})

// --- priority lanes + token bucket ------------------------------------------------------------
// The gate is what a trade sits behind. Fixed 2s spacing cost a real trade ~5-6s (measured: three
// concurrent callers at 2.01s / 4.00s / 5.98s, one prepare at 1.76s instead of 0.21s). These pin the
// policy that replaced it: a burst inside the measured tolerance, a reserve the background cannot
// touch, and a background lane that yields to trade work.
import {
  canTakeJupiterToken,
  createJupiterGate,
  refillJupiterTokens,
  resolveJupiterBurstCapacity,
  resolveJupiterTradeReserve,
  takeJupiterToken,
  type JupiterGateState,
} from './jupiter-rps'

const CFG = { rps: 0.5, capacity: 4, tradeReserve: 2 }

function state(tokens: number, tradeWaiting = 0): JupiterGateState {
  return { tokens, updatedAt: 1000, tradeWaiting }
}

describe('jupiter gate: burst bucket', () => {
  it('lets a trade spend the whole bucket back-to-back', () => {
    const s = state(4)
    const waited: number[] = []
    for (let i = 0; i < 4; i++) {
      const d = canTakeJupiterToken(s, 'trade', CFG)
      waited.push(d.waitMs)
      expect(d.ok).toBe(true)
      takeJupiterToken(s)
    }
    expect(waited).toEqual([0, 0, 0, 0])
    expect(s.tokens).toBe(0)
  })

  it('refills proportionally and never past capacity', () => {
    const s = state(0)
    refillJupiterTokens(s, 1000 + 2000, CFG) // 2s at 0.5 rps = 1 token
    expect(s.tokens).toBeCloseTo(1, 5)
    refillJupiterTokens(s, 1000 + 60_000, CFG)
    expect(s.tokens).toBe(CFG.capacity)
  })

  it('reports the wait until the next token rather than a fixed interval', () => {
    const s = state(0)
    expect(canTakeJupiterToken(s, 'trade', CFG)).toEqual({ ok: false, waitMs: 2000 })
  })
})

describe('jupiter gate: lanes', () => {
  it('keeps the reserve for trades — background cannot spend it', () => {
    const s = state(2) // exactly the reserve
    expect(canTakeJupiterToken(s, 'background', CFG).ok).toBe(false)
    expect(canTakeJupiterToken(s, 'trade', CFG).ok).toBe(true)
  })

  it('lets background use tokens above the reserve', () => {
    expect(canTakeJupiterToken(state(3), 'background', CFG).ok).toBe(true)
  })

  it('makes background yield whenever trade work is waiting, reserve or not', () => {
    expect(canTakeJupiterToken(state(4, 1), 'background', CFG).ok).toBe(false)
    expect(canTakeJupiterToken(state(4, 1), 'trade', CFG).ok).toBe(true)
  })
})

describe('jupiter gate config', () => {
  it('defaults inside the measured burst tolerance and never reserves the whole bucket', () => {
    // 5: fits a 5-token bulk batch in one burst (4 dribbled the 5th out at 2s) while staying under the Free
    // plan's ~10 requests / 10 s window (8 did not leave enough headroom).
    expect(resolveJupiterBurstCapacity({})).toBe(5)
    expect(resolveJupiterTradeReserve({})).toBe(2)
    expect(resolveJupiterTradeReserve({ JUPITER_BURST: '3', JUPITER_TRADE_RESERVE: '99' })).toBe(2)
    expect(createJupiterGate({ JUPITER_MAX_RPS: '1', JUPITER_BURST: '8' })).toEqual({
      rps: 1,
      capacity: 8,
      tradeReserve: 2,
    })
  })
})
