import { beforeEach, describe, expect, it, vi } from 'vitest'

const MINT_OPEN = 'MintOpen11111111111111111111111111111111111'
const MINT_NEW = 'MintNew111111111111111111111111111111111111'

const order: string[] = []
const retire = vi.fn(async (p: { mintAddress: string }) => {
  order.push(`retire:${p.mintAddress}`)
  return 1
})
const register = vi.fn(async (p: { mintAddress: string }) => {
  order.push(`register:${p.mintAddress}`)
  return 'row'
})

const strategy = {
  id: 'att_rh',
  stop_loss_percentage: -30,
  max_hold_hours: 48,
  max_open_positions: 5,
  buy_amount_native: 0.001,
  conditions: {},
  take_profit_levels: {
    tp1_percentage: 50,
    tp1_sell_percentage: 90,
    tp2_percentage: 100,
    tp3_percentage: 200,
    tp3_enabled: false,
  },
}

let prices: Record<string, number> = {}
let tokens: Array<Record<string, unknown>> = []

vi.mock('@/strategies/sim-exit-contract', () => ({
  registerSimExitContract: (p: { mintAddress: string }) => register(p),
  retireSimExitContract: (p: { mintAddress: string }) => retire(p),
}))
vi.mock('@/strategies/db', () => ({
  fetchTradingRecordsForWallet: vi.fn(async () => [
    {
      id: 'b1',
      walletAddress: 'trending-bot-rh-sim',
      is_simulation: true,
      simulation_type: 'strategy',
      operationType: 'buy',
      bot_strategy: 'att_rh',
      successCount: 1,
      failureCount: 0,
      solAmount: 0.001,
      totalTokens: 1,
      feesPaid: 0,
      solPriceUsd: 3000,
      signatures: [],
      timestamp: 1,
      tokens: [{ mintAddress: MINT_OPEN, symbol: 'OPN', tokenAmount: 100, priceUsd: 0.001, solAmount: 0.001 }],
      trading_simulation: { entry_at: new Date().toISOString(), entry_price_usd: 0.001, entry_features: {} },
    },
  ]),
}))
vi.mock('@/strategies/load-strategy', () => ({
  getActiveStrategiesWithState: vi.fn(async () => ({
    strategies: ['att_rh'],
    configs: { att_rh: strategy },
  })),
}))
vi.mock('@/strategies/outcomes', () => ({
  loadClosedTrendingOutcomes: vi.fn(async () => []),
  recordTrendingBotOutcome: vi.fn(async () => undefined),
}))
vi.mock('@/utils/gmgn-trending-feed', () => ({
  getFilteredGmgnTrending: vi.fn(async () => ({ tokens })),
}))
vi.mock('@/utils/native-usd', () => ({ getNativeUsd: vi.fn(async () => 3000) }))
vi.mock('@/utils/open-position-prices', () => ({
  getOpenPositionPrices: vi.fn(async () => prices),
}))
vi.mock('@/utils/brain-regime-risk', () => ({
  createBrainRiskSession: vi.fn(() => ({})),
  resolveSimOpenSize: vi.fn(async () => ({ skip: false, sol: 0.001, risk: {} })),
  stampBrainRisk: vi.fn((f: Record<string, unknown>) => f),
}))
vi.mock('@/utils/trading-records-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/trading-records-db')>()),
  insertTradingRecords: vi.fn(async () => ({
    inserted: 1,
    skipped: 0,
    stats: { chunks: 1 },
  })),
}))

const { runTrendingBotRhSimCycle } = await import('@/strategies/trending-bot-rh-sim')

describe('att_rh shadow mirror lifecycle', () => {
  beforeEach(() => {
    order.length = 0
    retire.mockClear()
    register.mockClear()
    tokens = []
    prices = {}
  })

  it('retires the mirror when att_rh closes a position on its own ladder', async () => {
    prices = { [MINT_OPEN]: 0.0005 } // -50% vs entry 0.001 → stop loss
    const [res] = await runTrendingBotRhSimCycle()
    expect(res!.closed).toBe(1)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(retire).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: 'trending-bot-sim-rh',
        strategyId: 'att_rh',
        mintAddress: MINT_OPEN,
        chain: 'robinhood',
      }),
    )
  })

  it('does not retire on hold', async () => {
    prices = { [MINT_OPEN]: 0.001 }
    const [res] = await runTrendingBotRhSimCycle()
    expect(res!.closed).toBe(0)
    expect(retire).not.toHaveBeenCalled()
  })

  it('retires any stale mirror BEFORE registering a re-entered mint (no duplicate active rows)', async () => {
    prices = { [MINT_OPEN]: 0.001 }
    tokens = [
      {
        token_address: MINT_NEW,
        token_symbol: 'NEW',
        price: 0.002,
        mcap: 1000,
        organic_score: 90,
        change_5m: 1,
        change_1h: 1,
      },
    ]
    const [res] = await runTrendingBotRhSimCycle()
    expect(res!.opened).toBe(1)
    expect(order).toEqual([`retire:${MINT_NEW}`, `register:${MINT_NEW}`])
  })
})
