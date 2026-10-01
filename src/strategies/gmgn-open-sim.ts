import { buildFullEntryFeatureSnapshot } from '@/strategies/resolve-entry-snapshot'
import type { GmgnStrategy } from '@/strategies/types'
import { getNativeUsd } from '@/utils/native-usd'
import { simWalletForChain } from '@/strategies/sim-wallets'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import {
  createBrainRiskSession,
  resolveSimOpenSize,
  stampBrainRisk,
  type BrainRiskSession,
} from '@/utils/brain-regime-risk'
import { registerSimExitContract } from './sim-exit-contract'

export const GMGN_SIM_WALLET =
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim'

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function gmgnTopHoldersToPct(rate: number | null): number | null {
  if (rate == null) return null
  if (rate >= 0 && rate <= 1) return rate * 100
  return rate
}

export async function openGmgnSimPosition(params: {
  strategy: GmgnStrategy
  mintAddress: string
  symbol: string
  entryFeatures: Record<string, unknown>
  entryPriceUsd: number
  /** Created once per sim cycle so the recipe/params fetch is shared across candidates. */
  brainRiskSession?: BrainRiskSession
}): Promise<boolean> {
  const chain = params.strategy.chain ?? 'sol'
  // solAmount / solPrice are native-token denominated; that's ETH on robinhood.
  const baseSol =
    params.strategy.config.execution.simBuyNative ??
    params.strategy.config.execution.simBuySol
  const solPrice = await getNativeUsd(chain)

  // Level 1 market scalar, on the same path as mcap/signals/trending. Resolved before the spine so
  // a stand-down skips the open entirely rather than recording a zero-size position.
  const session = params.brainRiskSession ?? createBrainRiskSession()
  const sized = await resolveSimOpenSize({
    session,
    strategyId: params.strategy.id,
    baseSol,
  })
  if (sized.skip) {
    const { appendSpineDecision, spineSkipDecision } = await import('@/strategies/spine-tick-log')
    await appendSpineDecision(
      spineSkipDecision(
        'gmgn_sim_track',
        params.mintAddress,
        'size',
        sized.risk.standDown ? 'brain_risk_stand_down' : 'brain_risk_zero_size',
        params.symbol,
      ),
    )
    return false
  }

  const entryAt = new Date().toISOString()
  const entryMcap = readFiniteNumber(params.entryFeatures.gmgn_market_cap_usd)
  const topHoldersPct = gmgnTopHoldersToPct(
    readFiniteNumber(params.entryFeatures.gmgn_top_10_holder_rate),
  )

  const fullFeatures = await buildFullEntryFeatureSnapshot(
    params.mintAddress,
    {
      entryAt,
      entryMcap,
      topHoldersPct,
      tokenSymbol: params.symbol,
    },
    params.entryFeatures,
  )
  const { prepareTargetMachinePaperOpen } = await import(
    '@/strategies/prepare-target-machine-paper-open'
  )
  const {
    appendSpineDecision,
    spinePassDecision,
    spineSkipDecision,
  } = await import('@/strategies/spine-tick-log')
  const spine = await prepareTargetMachinePaperOpen({
    mint: params.mintAddress,
    chain,
    features: fullFeatures,
    priceUsd: params.entryPriceUsd > 0 ? params.entryPriceUsd : null,
    baseSol: sized.sol,
    baseExit: params.strategy.config.exit,
    entryMcap,
  })
  if (!spine.ok) {
    await appendSpineDecision(
      spineSkipDecision(
        'gmgn_sim_track',
        params.mintAddress,
        spine.stage,
        spine.reason,
        params.symbol,
      ),
    )
    return false
  }
  const solAmount = spine.solAmount
  const priceUsd = spine.priceUsd
  // Stamp the applied scalar so a row is auditable on its own, and so a later re-tune can tell
  // whether the risk layer was in the path at all.
  const stampedFeatures = stampBrainRisk(spine.features, sized.risk, { sizedSol: solAmount })
  const tokenAmount =
    priceUsd > 0 && solPrice > 0 ? (solAmount * solPrice) / priceUsd : solAmount * 1_000_000

  const walletAddress = simWalletForChain(GMGN_SIM_WALLET, chain)
  const record = buildTradingRecord({
    walletAddress,
    chain,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategy.id,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    signatures: [`gmgn-sim-open-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      entry_at: entryAt,
      entry_price_usd: priceUsd,
      effective_exit: spine.effectiveExit,
      entry_features: {
        ...stampedFeatures,
        entry_at: entryAt,
        initial_price_usd: priceUsd,
        token_symbol: params.symbol,
      },
    },
  })

  await insertTradingRecord(record)

  // The exit contract (S8/S10). Without this the position is invisible to the worker, and its
  // exit is decided only by whatever closer this family happens to run.
  await registerSimExitContract({
    chain,
    walletAddress,
    strategyId: params.strategy.id,
    mintAddress: params.mintAddress,
    symbol: params.symbol,
    positionSize: solAmount,
    entryPriceUsd: spine.impactedPriceUsd,
    basis: spine.exitBasis,
    thresholds: spine.effectiveExit,
  })

  const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
  notifyStrategyOpen({
    domain: 'gmgn',
    strategyId: params.strategy.id,
    tokenSymbol: params.symbol,
    tokenAddress: params.mintAddress,
    marketCap: entryMcap,
    isSimulated: true,
    topHoldersPct,
    features: stampedFeatures,
  })
  await appendSpineDecision(
    spinePassDecision('gmgn_sim_track', params.mintAddress, params.symbol, {
      p: spine.p,
      solAmount: spine.solAmount,
      takeProfitPct: spine.effectiveExit.takeProfitPct,
      stopLossPct: spine.effectiveExit.stopLossPct,
    }),
  )
  return true
}
