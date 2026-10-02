import { beforeEach, describe, expect, it, vi } from 'vitest'

// The row writer is the DB seam. Mocked so these stay pure: what matters here is the SHAPE of the
// contract handed to the tracker, not the insert.
vi.mock('@/utils/sl-tp-tracker', () => ({
  addSLTPPosition: vi.fn(async () => 'row-1'),
}))

const { addSLTPPosition } = await import('@/utils/sl-tp-tracker')
const { registerSimExitContract, impactedEntryPriceUsd, simExitRegistrationFailureCount } =
  await import('./sim-exit-contract')

const base = {
  chain: 'sol',
  walletAddress: 'gmgn-sim',
  strategyId: 'gmgn_sm_kol_combined',
  mintAddress: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  symbol: 'TEST',
  positionSize: 0.02,
  entryPriceUsd: 1,
  thresholds: { takeProfitPct: 200, stopLossPct: 30, maxHoldHours: 48 },
}

describe('registerSimExitContract — the contract every open stamps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stamps the basis, the reference value and a NEGATIVE stop', async () => {
    await registerSimExitContract(base)

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceKind: 'price',
        referenceValue: 1,
        exitBasis: 'price',
        isSimulation: true,
        chain: 'sol',
        // A stored +30 would sit above the entry and trip on the first tick.
        stopLossPercentage: -30,
        takeProfitPercentage: 200,
      }),
    )
  })

  it('falls back to the entry price as the reference when no basis is given', async () => {
    await registerSimExitContract({ ...base, entryPriceUsd: 0.00042 })

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({ referenceValue: 0.00042, exitBasis: 'price' }),
    )
  })

  it('honours a declared mcap basis rather than inferring it from the caller', async () => {
    await registerSimExitContract({
      ...base,
      basis: 'mcap',
      referenceValue: 42000,
    })

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceKind: 'mcap',
        exitBasis: 'mcap',
        referenceValue: 42000,
      }),
    )
  })

  it('registers the ladder as ONE target, which is why TP2/TP3 read 0 forever', async () => {
    // This is deliberate, not a defect, and it is the reason the worker's TP2/TP3 counters are
    // always 0: a `bot` row reads only the tpN ladder, so the single target is expressed as TP1 —
    // and TP1 sells 100%, which closes the position, leaving no tiers above it to reach. A
    // three-tier ladder that only ever uses tier 1 is indistinguishable from a single TP.
    await registerSimExitContract(base)

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        tp1Percentage: 200,
        tp1SellPercentage: 100,
        tp3Enabled: false,
      }),
    )
  })

  it('PASSES THE BACKSTOP THROUGH, which it used to drop on the floor', async () => {
    // `SimExitThresholds` has always carried `maxHoldHours` and every strategy config resolves one,
    // but `addSLTPPosition` accepted no such parameter — so the value was type-checked, resolved,
    // and thrown away. `checkSLTPTriggers` therefore had nothing to give the evaluator, `max_hold`
    // could not fire, and a position that never crossed its stop or its target never closed at all.
    await registerSimExitContract(base)

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({ maxHoldHours: 48 }),
    )
  })

  it('carries a non-default TP1 sell percentage, so a LADDERED strategy is shadowed faithfully', async () => {
    // `att_rh` sells 90% at TP1 and closes the rest at TP2. Registering it as 100 would compare a
    // different strategy from the one running, which is the one thing a shadow must not do.
    await registerSimExitContract({
      ...base,
      strategyId: 'att_rh',
      thresholds: { ...base.thresholds, tp1SellPct: 90 },
    })

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({ tp1SellPercentage: 90 }),
    )
  })

  it('defaults TP1 to a full sell when a strategy does not ladder', async () => {
    await registerSimExitContract(base)

    expect(addSLTPPosition).toHaveBeenCalledWith(
      expect.objectContaining({ tp1SellPercentage: 100 }),
    )
  })

  it('refuses to register without a usable entry price, rather than inventing one', async () => {
    // Existing behaviour, kept: fabricating a price would fabricate trigger data.
    expect(await registerSimExitContract({ ...base, entryPriceUsd: 0 })).toBeNull()
    expect(await registerSimExitContract({ ...base, entryPriceUsd: Number.NaN })).toBeNull()
    expect(addSLTPPosition).not.toHaveBeenCalled()
  })

  it('refuses to register when the thresholds are not real numbers', async () => {
    expect(
      await registerSimExitContract({
        ...base,
        thresholds: { takeProfitPct: Number.NaN, stopLossPct: 30, maxHoldHours: 48 },
      }),
    ).toBeNull()
    expect(addSLTPPosition).not.toHaveBeenCalled()
  })

  it('COUNTS a refused registration, so a silently-unregistered strategy is measurable', async () => {
    // The refusal was already a `console.warn`, which is why a strategy whose opens stopped
    // registering looked exactly like one that had simply not opened. The counter is what makes it
    // a number something can alert on.
    const before = simExitRegistrationFailureCount()

    await registerSimExitContract({ ...base, entryPriceUsd: 0 })
    expect(simExitRegistrationFailureCount()).toBe(before + 1)

    await registerSimExitContract({
      ...base,
      thresholds: { takeProfitPct: Number.NaN, stopLossPct: 30, maxHoldHours: 48 },
    })
    expect(simExitRegistrationFailureCount()).toBe(before + 2)

    // A successful registration must not move it.
    await registerSimExitContract(base)
    expect(simExitRegistrationFailureCount()).toBe(before + 2)
  })
})

describe('impactedEntryPriceUsd — the price S10 says the stop is measured from', () => {
  it('returns the spot price unchanged when the inputs cannot support a fill', () => {
    // Never zero: a caller must always get a usable reference.
    expect(impactedEntryPriceUsd({ spotPriceUsd: 0, notionalQuote: 1 })).toBe(0)
    expect(impactedEntryPriceUsd({ spotPriceUsd: 1, notionalQuote: 0 })).toBe(1)
  })

  it('never returns worse than the spot it was given, on a non-negative impact model', () => {
    const spot = 0.001
    const filled = impactedEntryPriceUsd({ spotPriceUsd: spot, notionalQuote: 1 })
    expect(Number.isFinite(filled)).toBe(true)
    expect(filled).toBeGreaterThanOrEqual(spot)
  })
})

describe('retireSimExitContract — shadow mirror retirement', () => {
  it('deactivates every active simulated row for the (wallet, strategy, mint) tuple as removed', async () => {
    vi.resetModules()
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }))
    vi.doMock('@/utils/db', () => ({ query }))
    vi.doMock('@/utils/sl-tp-tracker', () => ({ addSLTPPosition: vi.fn() }))
    const { retireSimExitContract } = await import('./sim-exit-contract')

    const n = await retireSimExitContract({
      walletAddress: 'trending-bot-rh-sim',
      strategyId: 'att_rh',
      mintAddress: 'MintX',
      chain: 'robinhood',
    })
    expect(n).toBe(2)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("is_active = false, close_reason = 'removed'")
    expect(sql).toContain('is_simulation = true')
    expect(sql).toContain('is_active = true')
    expect(params[0]).toBe('trending-bot-rh-sim')
    expect(params[1]).toBe('att_rh')
    expect(params[2]).toBe('MintX')
    expect(params[4]).toBe('robinhood')
  })

  it('never throws — a failed retire returns 0', async () => {
    vi.resetModules()
    vi.doMock('@/utils/db', () => ({
      query: vi.fn(async () => {
        throw new Error('db down')
      }),
    }))
    vi.doMock('@/utils/sl-tp-tracker', () => ({ addSLTPPosition: vi.fn() }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { retireSimExitContract } = await import('./sim-exit-contract')
    await expect(
      retireSimExitContract({ walletAddress: 'w', strategyId: 's', mintAddress: 'm' }),
    ).resolves.toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
