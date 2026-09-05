'use client'

import { useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useRhWalletMode } from '@/contexts/RhWalletModeContext'
import { useTradingData } from '@/components/TradingDataProvider'
import {
  tradingTracker,
  type TrackingRecord,
} from '@/utils/trading-tracker'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import { useRhWalletTokens } from '@/hooks/useRhWalletTokens'
import {
  executeGmgnBulkBuy,
  executeGmgnBulkSell,
} from '@/utils/gmgn-bulk-trade'
import {
  executeRhParentKyberBuy,
  executeRhParentKyberSell,
} from '@/utils/dlmm/rh-kyber-swap'
import { getRhBatchExecutorAddress, RH_PLATFORM_FEE_LABEL } from '@/utils/dlmm/rh-batch-executor'
import {
  GMGN_RH_USDG,
  GMGN_RH_WETH,
  gmgnNativeToken,
  gmgnTokenDecimals,
  isValidTradeTokenAddress,
} from '@/utils/gmgn-currencies'
import type { RhSwapQuote } from '@/utils/dlmm/rh-univ2-swap'
import { RH_WETH, erc20Abi } from '@/utils/dlmm/rh-univ2'
import { resolveRhActiveAddress } from '@/utils/rh-wallet-mode'
import UniversalWalletButton from '@/components/UniversalWalletButton'
import GmgnTradeConfirmModal, {
  type GmgnConfirmLeg,
} from '@/components/GmgnTradeConfirmModal'
import {
  fetchEthUsdSpot,
  simulateRhBoundBuyLeg,
  simulateRhBoundSellLeg,
  simulateRhParentBuyLeg,
  simulateRhParentSellLeg,
} from '@/utils/rh-trade-sim'
import {
  buildRhBuyToken,
  buildRhSellToken,
  buildRhTokenToTokenSwap,
  rhQuoteUsdPerUnit,
} from '@/utils/rh-trade-record'
import { quoteIsVolatile } from '@/utils/auto-slippage'
import {
  readTradeAutoConfirm,
  writeTradeAutoConfirm,
} from '@/utils/trade-auto-confirm'
import HoldingsTokenList from '@/components/HoldingsTokenList'
import { walletsMatch } from '@/utils/rh-wallet-holdings'

type Side = 'buy' | 'sell'
type SwapMode = 'quote' | 'tokenToToken'

function gmgnQuoteToken(quote: RhSwapQuote): string {
  if (quote === 'USDG') return GMGN_RH_USDG
  if (quote === 'WETH') return GMGN_RH_WETH
  return gmgnNativeToken('robinhood')
}

/** Single-leg RH swap: Bound=GMGN server-sign, Parent=Kyber + Rabby. */
export default function RhGmgnSwapPanel({
  initialToken = '',
  initialFromToken = '',
}: {
  initialToken?: string
  initialFromToken?: string
}) {
  const { network } = useAppNetwork()
  const { mode: rhMode } = useRhWalletMode()
  const { trackOperation } = useTradingData()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const from = resolveRhActiveAddress(rhMode, rh.address, bound.evm)
  const isParent = rhMode === 'parent'
  const holdings = useRhWalletTokens()

  const [mode, setMode] = useState<SwapMode>(
    initialFromToken && initialToken ? 'tokenToToken' : 'quote',
  )
  const [side, setSide] = useState<Side>('buy')
  const [quote, setQuote] = useState<RhSwapQuote>('ETH')
  const [token, setToken] = useState(initialToken)
  const [fromToken, setFromToken] = useState(initialFromToken)
  const [amount, setAmount] = useState('0.01')
  const [sellPct, setSellPct] = useState('100')
  const [slippageBps, setSlippageBps] = useState(200)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [okMsg] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmLegs, setConfirmLegs] = useState<GmgnConfirmLeg[]>([])
  const [tradeAutoConfirm, setTradeAutoConfirm] = useState(readTradeAutoConfirm)
  const [quoteRefreshing, setQuoteRefreshing] = useState(false)
  const autoConfirmFiredRef = useRef(false)
  // Sim snapshot captured at review time; reused to record the trade so we
  // don't re-quote and so the tracked record carries real token amounts.
  const [pendingSim, setPendingSim] = useState<{
    side: Side
    ethUsd: number
    estOutRaw: string | null
    amountOutHuman: number | null
    amountInHuman: number | null
    toUsd: number | null
  } | null>(null)
  // On-chain submit state: real loading until the receipt resolves, then an
  // explicit success/failed screen (see GmgnTradeConfirmModal).
  const [submitPhase, setSubmitPhase] = useState<
    'idle' | 'submitting' | 'success' | 'failed'
  >('idle')
  const [submitResult, setSubmitResult] = useState<{
    ok: boolean
    message: string
    hash?: string
  } | null>(null)
  const pendingRef = useRef<string | null>(null)
  const openConfirmRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(
    async () => {},
  )
  const runConfirmedRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    if (network !== 'robinhood' || !confirmOpen || submitPhase !== 'idle') return
    const id = window.setInterval(() => {
      void openConfirmRef.current({ silent: true })
    }, 2500)
    return () => window.clearInterval(id)
  }, [network, confirmOpen, submitPhase])

  useEffect(() => {
    if (network !== 'robinhood' || !confirmOpen || submitPhase !== 'idle' || busy) {
      return
    }
    if (!tradeAutoConfirm) return
    if (quoteIsVolatile(confirmLegs.map((l) => l.priceImpactPct))) return
    if (autoConfirmFiredRef.current) return
    autoConfirmFiredRef.current = true
    void runConfirmedRef.current()
  }, [
    network,
    confirmOpen,
    submitPhase,
    busy,
    tradeAutoConfirm,
    confirmLegs,
  ])

  if (network !== 'robinhood') return null

  async function openConfirm(opts?: { silent?: boolean }) {
    const silent = Boolean(opts?.silent)
    if (silent && !confirmOpen) return
    setError('')
    if (!from) {
      if (silent) return
      setError(
        isParent
          ? 'Connect Rabby (parent wallet)'
          : 'Bind a GMGN EVM wallet or switch to Parent',
      )
      return
    }
    // ── Token-to-token mode ────────────────────────────────────────────
    if (mode === 'tokenToToken') {
      const fromAddr = fromToken.trim()
      const toAddr = token.trim()
      if (!isValidTradeTokenAddress('robinhood', fromAddr)) {
        setError('Enter a valid From token address')
        return
      }
      if (!isValidTradeTokenAddress('robinhood', toAddr)) {
        setError('Enter a valid To token address')
        return
      }
      if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
        setError('From and To tokens must differ')
        return
      }
      const pct = parseFloat(sellPct)
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        setError('Sell % must be 1–100')
        return
      }
      if (!silent) setBusy(true)
      else setQuoteRefreshing(true)
      try {
        const ethUsd = await fetchEthUsdSpot()
        const fromHeld = holdings.tokens.find(
          (t) => t.mintAddress.toLowerCase() === fromAddr.toLowerCase(),
        )
        const toHeld = holdings.tokens.find(
          (t) => t.mintAddress.toLowerCase() === toAddr.toLowerCase(),
        )
        const fromTokenDecimals = fromHeld?.decimals ?? 18
        const toTokenDecimals = toHeld?.decimals ?? 18
        let amountRaw = '0'
        if (!isParent) {
          const bal = (await rh.getPublicClient().readContract({
            address: fromAddr as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [from as Address],
          })) as bigint
          amountRaw = (
            (bal * BigInt(Math.floor(pct * 100))) /
            BigInt(10_000)
          ).toString()
        }
        const sim = isParent
          ? await simulateRhParentSellLeg({
              publicClient: rh.getPublicClient(),
              account: from as Address,
              tokenAddress: fromAddr,
              percent: pct,
              quote: 'ETH', // dummy; outputToken overrides below
              ethUsd,
              tokenDecimals: fromTokenDecimals,
              outputToken: toAddr,
              outputDecimals: toTokenDecimals,
            })
          : await simulateRhBoundSellLeg({
              from,
              tokenAddress: fromAddr,
              percent: pct,
              quote: 'ETH',
              slippageBps,
              ethUsd,
              amountRaw,
              tokenDecimals: fromTokenDecimals,
              outputToken: toAddr,
              outputDecimals: toTokenDecimals,
            })
        const fromSym = fromHeld?.symbol ?? 'token'
        const toSym = toHeld?.symbol ?? 'token'
        const leg: GmgnConfirmLeg = {
          tokenAddress: fromAddr,
          amountLabel: `${pct}% ${fromSym} → ${toSym}${isParent ? ' · Kyber' : ' · GMGN'}`,
          side: 'sell',
          estOut: sim.amountOutRaw ?? undefined,
          fromUsd: sim.fromUsd,
          toUsd: sim.toUsd,
          priceImpactPct: sim.priceImpactPct,
        }
        setPendingSim({
          side: 'sell',
          ethUsd,
          estOutRaw: sim.amountOutRaw,
          amountOutHuman: sim.amountOutHuman,
          amountInHuman: sim.amountInHuman,
          toUsd: sim.toUsd,
        })
        setConfirmLegs([leg])
        if (!silent) {
          autoConfirmFiredRef.current = false
          setConfirmOpen(true)
        }
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (silent) setQuoteRefreshing(false)
        else setBusy(false)
      }
      return
    }
    // ── Quote-pair mode (existing behavior) ────────────────────────────
    const addr = token.trim()
    if (!isValidTradeTokenAddress('robinhood', addr)) {
      setError('Enter a valid Robinhood token address')
      return
    }
    if (quote === 'WETH' && addr.toLowerCase() === RH_WETH.toLowerCase()) {
      setError('Cannot trade WETH against WETH')
      return
    }
    if (!silent) setBusy(true)
    else setQuoteRefreshing(true)
    try {
      const ethUsd = await fetchEthUsdSpot()
      const held = holdings.tokens.find(
        (t) => t.mintAddress.toLowerCase() === addr.toLowerCase(),
      )
      const tokenDecimals = held?.decimals ?? 18
      let leg: GmgnConfirmLeg
      if (side === 'buy') {
        const human = parseFloat(amount)
        if (!Number.isFinite(human) || human <= 0) {
          throw new Error(`Enter a valid ${quote} amount`)
        }
        const sim = isParent
          ? await simulateRhParentBuyLeg({
              amountHuman: human,
              tokenAddress: addr,
              quote,
              ethUsd,
              tokenDecimals,
            })
          : await simulateRhBoundBuyLeg({
              from,
              amountHuman: human,
              tokenAddress: addr,
              quote,
              slippageBps,
              ethUsd,
              tokenDecimals,
            })
        leg = {
          tokenAddress: addr,
          amountLabel: `${human} ${quote}${isParent ? ' · Kyber' : ' · GMGN'}`,
          side: 'buy',
          estOut: sim.amountOutRaw ?? undefined,
          fromUsd: sim.fromUsd,
          toUsd: sim.toUsd,
          priceImpactPct: sim.priceImpactPct,
        }
        setPendingSim({
          side: 'buy',
          ethUsd,
          estOutRaw: sim.amountOutRaw,
          amountOutHuman: sim.amountOutHuman,
          amountInHuman: sim.amountInHuman,
          toUsd: sim.toUsd,
        })
      } else {
        const pct = parseFloat(sellPct)
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          throw new Error('Sell % must be 1–100')
        }
        let sim
        if (isParent) {
          sim = await simulateRhParentSellLeg({
            publicClient: rh.getPublicClient(),
            account: from as Address,
            tokenAddress: addr,
            percent: pct,
            quote,
            ethUsd,
            tokenDecimals,
          })
        } else {
          const bal = (await rh.getPublicClient().readContract({
            address: addr as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [from as Address],
          })) as bigint
          const amountRaw = (
            (bal * BigInt(Math.floor(pct * 100))) /
            BigInt(10_000)
          ).toString()
          sim = await simulateRhBoundSellLeg({
            from,
            tokenAddress: addr,
            percent: pct,
            quote,
            slippageBps,
            ethUsd,
            amountRaw,
            tokenDecimals,
          })
        }
        leg = {
          tokenAddress: addr,
          amountLabel: `${pct}% → ${quote}${isParent ? ' · Kyber' : ' · GMGN'}`,
          side: 'sell',
          estOut: sim.amountOutRaw ?? undefined,
          fromUsd: sim.fromUsd,
          toUsd: sim.toUsd,
          priceImpactPct: sim.priceImpactPct,
        }
        setPendingSim({
          side: 'sell',
          ethUsd,
          estOutRaw: sim.amountOutRaw,
          amountOutHuman: sim.amountOutHuman,
          amountInHuman: sim.amountInHuman,
          toUsd: sim.toUsd,
        })
      }
      setConfirmLegs([leg])
      if (!silent) {
        autoConfirmFiredRef.current = false
        setConfirmOpen(true)
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (silent) setQuoteRefreshing(false)
      else setBusy(false)
    }
  }

  async function runConfirmed() {
    if (!from) return
    const addr = token.trim()
    setBusy(true)
    setError('')
    setSubmitPhase('submitting')
    setSubmitResult(null)

    const opType: 'buy' | 'sell' =
      mode === 'tokenToToken' ? 'sell' : side === 'buy' ? 'buy' : 'sell'

    // Persist a pending "in-flight" record so the history feed shows the swap
    // is awaiting confirmation; it's promoted to confirmed/failed once the
    // on-chain receipt resolves.
    pendingRef.current = null
    try {
      const pending = await tradingTracker.trackOperation({
        walletAddress: from,
        operationType: opType,
        chain: 'robinhood',
        tokens: [],
        successCount: 0,
        failureCount: 0,
        totalTokens: 1,
        feesPaid: 0,
        signatures: [],
        slippage: slippageBps / 100,
        txStatus: 'pending',
      })
      pendingRef.current = pending.id
    } catch (e) {
      console.warn('[RhGmgnSwapPanel] could not persist pending record:', e)
    }

    // Promote the pending record (or fall back to a fresh insert if the
    // pending insert failed). A tracking hiccup must never abort the swap's
    // on-chain result, so this is best-effort.
    const finalizePending = async (
      op: Omit<TrackingRecord, 'id' | 'timestamp'>,
    ): Promise<void> => {
      try {
        if (pendingRef.current) {
          await tradingTracker.updateRecord(
            pendingRef.current,
            op,
            from,
            'robinhood',
          )
        } else {
          await trackOperation(op)
        }
      } catch (e) {
        console.warn('[RhGmgnSwapPanel] failed to finalize trade record:', e)
      }
    }

    // Apply the terminal result exactly once per swap: record the real
    // success/failure counts and flip the modal to a success or failure
    // screen. This is the single source of truth for "only success or failed
    // after on-chain confirmation" — no early throw double-marks.
    const settle = async (params: {
      results: ReadonlyArray<{
        success: boolean
        hash?: string
        orderId?: string
        error?: string
      }>
      success: boolean
      message: string
      record: Omit<TrackingRecord, 'id' | 'timestamp' | 'successCount' | 'failureCount' | 'totalTokens'>
    }): Promise<void> => {
      const okCount = params.results.filter((r) => r.success).length
      const failCount = params.results.length - okCount
      const confirmed = params.results.find((r) => r.hash || r.orderId)
      const hash =
        confirmed?.hash ??
        (confirmed?.orderId ? String(confirmed.orderId) : undefined)
      await finalizePending({
        ...params.record,
        successCount: okCount,
        failureCount: failCount,
        totalTokens: params.results.length,
        txStatus: params.success ? 'confirmed' : 'failed',
      })
      if (params.success) {
        setSubmitResult({ ok: true, message: params.message, hash })
        setSubmitPhase('success')
      } else {
        const msg =
          params.results.find((r) => r.error)?.error || params.message
        setSubmitResult({ ok: false, message: msg })
        setError(msg)
        setSubmitPhase('failed')
      }
    }

    try {
      // ── Token-to-token mode ──────────────────────────────────────────
      if (mode === 'tokenToToken') {
        const fromAddr = fromToken.trim()
        const toAddr = addr
        const pct = parseFloat(sellPct)
        let results: Awaited<ReturnType<typeof executeGmgnBulkSell>>['results']
        let success: boolean
        if (isParent) {
          const wc = await rh.getWalletClient()
          ;({ results, success } = await executeRhParentKyberSell({
            publicClient: rh.getPublicClient(),
            walletClient: wc,
            account: from as Address,
            legs: [{ tokenAddress: fromAddr, percent: pct }],
            slippageBps,
            quote: 'ETH',
            outputToken: toAddr,
          }))
        } else {
          ;({ results, success } = await executeGmgnBulkSell({
            chain: 'robinhood',
            from,
            legs: [{ tokenAddress: fromAddr, percent: pct }],
            outputToken: toAddr,
            slippageBps,
          }))
        }
        const ok = results.filter((r) => r.success)
        const fromHeld = holdings.tokens.find(
          (t) => t.mintAddress.toLowerCase() === fromAddr.toLowerCase(),
        )
        const toHeld = holdings.tokens.find(
          (t) => t.mintAddress.toLowerCase() === toAddr.toLowerCase(),
        )
        const sold = pendingSim?.amountInHuman ?? undefined
        const received = pendingSim?.amountOutHuman ?? undefined
        const built = ok.map((r) =>
          buildRhTokenToTokenSwap({
            from: {
              mintAddress: r.tokenAddress,
              symbol: fromHeld?.symbol,
              amount: sold,
            },
            to: {
              mintAddress: toAddr,
              symbol: toHeld?.symbol,
              amount: received,
            },
            fromUsd: pendingSim ? sold : undefined,
            toUsd: pendingSim?.toUsd ?? null,
          }),
        )
        const totalUsd = built.reduce((s, b) => s + b.usdValue, 0)
        await settle({
          results,
          success,
          message: 'Swap confirmed',
          record: {
            walletAddress: from,
            operationType: 'sell',
            chain: 'robinhood',
            tokens: built.flatMap((b) => b.tokens),
            solAmount: received,
            totalUsdValue: totalUsd > 0 ? totalUsd : undefined,
            solPriceUsd: undefined,
            feesPaid: 0,
            signatures: ok
              .map((r) => r.orderId || r.hash)
              .filter((id): id is string => Boolean(id)),
            slippage: slippageBps / 100,
          },
        })
        return
      }
      // ── Quote-pair mode ──────────────────────────────────────────────
      if (side === 'buy') {
        const human = parseFloat(amount)
        let results: Awaited<ReturnType<typeof executeGmgnBulkBuy>>['results']
        let success: boolean
        if (isParent) {
          const wc = await rh.getWalletClient()
          ;({ results, success } = await executeRhParentKyberBuy({
            publicClient: rh.getPublicClient(),
            walletClient: wc,
            account: from as Address,
            amountHuman: human,
            tokenMints: [{ tokenAddress: addr }],
            slippageBps,
            quote,
          }))
        } else {
          ;({ results, success } = await executeGmgnBulkBuy({
            chain: 'robinhood',
            from,
            amountHuman: human,
            inputToken: gmgnQuoteToken(quote),
            tokenMints: [{ tokenAddress: addr }],
            slippageBps,
          }))
        }
        const ok = results.filter((r) => r.success)
        const held = holdings.tokens.find(
          (t) => t.mintAddress.toLowerCase() === addr.toLowerCase(),
        )
        const ethUsd = pendingSim?.ethUsd ?? 0
        const usdPerUnit = rhQuoteUsdPerUnit(quote, ethUsd)
        const built = ok.map((r) =>
          buildRhBuyToken({
            mintAddress: r.tokenAddress,
            symbol: held?.symbol,
            spentQuote: human,
            usdPerUnit,
            estOutRaw: r.estOut ?? pendingSim?.estOutRaw,
            tokenDecimals: held?.decimals ?? 18,
          }),
        )
        const totalUsd = built.reduce((s, b) => s + b.usdValue, 0)
        await settle({
          results,
          success,
          message: 'Buy confirmed',
          record: {
            walletAddress: from,
            operationType: 'buy',
            chain: 'robinhood',
            tokens: built.map((b) => b.token),
            solAmount: human,
            totalUsdValue: totalUsd > 0 ? totalUsd : undefined,
            solPriceUsd: usdPerUnit > 0 ? usdPerUnit : undefined,
            feesPaid: 0,
            signatures: ok
              .map((r) => r.orderId || r.hash)
              .filter((id): id is string => Boolean(id)),
            slippage: slippageBps / 100,
          },
        })
      } else {
        const pct = parseFloat(sellPct)
        let results: Awaited<ReturnType<typeof executeGmgnBulkSell>>['results']
        let success: boolean
        if (isParent) {
          const wc = await rh.getWalletClient()
          ;({ results, success } = await executeRhParentKyberSell({
            publicClient: rh.getPublicClient(),
            walletClient: wc,
            account: from as Address,
            legs: [{ tokenAddress: addr, percent: pct }],
            slippageBps,
            quote,
          }))
        } else {
          ;({ results, success } = await executeGmgnBulkSell({
            chain: 'robinhood',
            from,
            legs: [{ tokenAddress: addr, percent: pct }],
            outputToken: gmgnQuoteToken(quote),
            slippageBps,
          }))
        }
        const ok = results.filter((r) => r.success)
        const held = holdings.tokens.find(
          (t) => t.mintAddress.toLowerCase() === addr.toLowerCase(),
        )
        const ethUsd = pendingSim?.ethUsd ?? 0
        const usdPerUnit = rhQuoteUsdPerUnit(quote, ethUsd)
        const receivedQuote =
          pendingSim?.amountOutHuman && pendingSim.amountOutHuman > 0
            ? pendingSim.amountOutHuman
            : undefined
        const built = ok.map((r) =>
          buildRhSellToken({
            mintAddress: r.tokenAddress,
            symbol: held?.symbol,
            soldTokenAmount: pendingSim?.amountInHuman ?? undefined,
            receivedQuote,
            usdPerUnit,
          }),
        )
        const totalUsd = built.reduce((s, b) => s + b.usdValue, 0)
        await settle({
          results,
          success,
          message: 'Sell confirmed',
          record: {
            walletAddress: from,
            operationType: 'sell',
            chain: 'robinhood',
            tokens: built.map((b) => b.token),
            solAmount: receivedQuote,
            totalUsdValue: totalUsd > 0 ? totalUsd : undefined,
            solPriceUsd: usdPerUnit > 0 ? usdPerUnit : undefined,
            feesPaid: 0,
            signatures: ok
              .map((r) => r.orderId || r.hash)
              .filter((id): id is string => Boolean(id)),
            slippage: slippageBps / 100,
          },
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Mark the pending record failed on any execution/confirmation error
      // (e.g. a rejected wallet prompt or a reverted receipt).
      try {
        await finalizePending({
          walletAddress: from,
          operationType: opType,
          chain: 'robinhood',
          tokens: [],
          successCount: 0,
          failureCount: 1,
          totalTokens: 1,
          feesPaid: 0,
          signatures: [],
          slippage: slippageBps / 100,
          txStatus: 'failed',
          errors: [message],
        })
      } catch {
        // finalizePending is already best-effort
      }
      setError(message)
      setSubmitResult({ ok: false, message })
      setSubmitPhase('failed')
    } finally {
      setBusy(false)
    }
  }

  openConfirmRef.current = openConfirm
  runConfirmedRef.current = runConfirmed

  return (
    <div className="w-full max-w-6xl mx-auto rounded-2xl border border-gray-700 bg-gray-900/80 p-6 space-y-4">
      <GmgnTradeConfirmModal
        open={confirmOpen}
        chain="robinhood"
        from={from || ''}
        legs={confirmLegs}
        busy={busy}
        sequentialSignHint={isParent && !getRhBatchExecutorAddress()}
        feeHint={
          isParent && getRhBatchExecutorAddress()
            ? RH_PLATFORM_FEE_LABEL
            : undefined
        }
        submitPhase={submitPhase}
        resultMessage={submitResult && !submitResult.ok ? submitResult.message : undefined}
        txHash={submitResult?.hash}
        volatile={quoteIsVolatile(confirmLegs.map((l) => l.priceImpactPct))}
        quoteRefreshing={quoteRefreshing}
        autoConfirm={tradeAutoConfirm}
        onAutoConfirmChange={(on) => {
          setTradeAutoConfirm(on)
          writeTradeAutoConfirm(on)
        }}
        onCancel={() => {
          autoConfirmFiredRef.current = false
          setSubmitPhase('idle')
          setConfirmOpen(false)
        }}
        onConfirm={() => void runConfirmed()}
        onDone={() => {
          setSubmitPhase('idle')
          setSubmitResult(null)
          pendingRef.current = null
          setConfirmOpen(false)
        }}
      />

      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Robinhood Swap</h2>
        <UniversalWalletButton />
      </div>
      <p className="text-xs text-gray-400">
        {isParent ? 'Kyber · Rabby sign' : 'GMGN · bound server-sign'} ·{' '}
        {mode === 'quote' ? `${quote} ↔ token` : 'Token → Token'} ·{' '}
        <span className="font-mono text-gray-300">
          {from ? `${from.slice(0, 6)}…${from.slice(-4)}` : 'none'}
        </span>
      </p>

      <div className="flex rounded-lg border border-gray-600 overflow-hidden text-xs">
        {(['quote', 'tokenToToken'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 py-1.5 font-medium ${
              mode === m
                ? 'bg-white text-black'
                : 'bg-black text-gray-400 hover:text-white'
            }`}
          >
            {m === 'quote' ? 'Quote pair' : 'Token → Token'}
          </button>
        ))}
      </div>

      {mode === 'quote' ? (
        <>
          <div className="flex rounded-lg border border-gray-600 overflow-hidden text-sm">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`flex-1 py-2 font-medium ${
                  side === s
                    ? 'bg-white text-black'
                    : 'bg-black text-gray-400 hover:text-white'
                }`}
              >
                {s === 'buy'
                  ? `Buy (${quote} → token)`
                  : `Sell (token → ${quote})`}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-300">
            <span>Quote:</span>
            {(['ETH', 'USDG', 'WETH'] as const).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuote(q)}
                className={`px-2 py-0.5 rounded font-mono ${
                  quote === q
                    ? 'bg-white text-black'
                    : 'bg-gray-700 text-gray-300 hover:text-white'
                }`}
              >
                {q}
              </button>
            ))}
          </div>

          <label className="block text-xs text-gray-400">
            Token address
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white font-mono text-sm"
              placeholder="0x…"
            />
          </label>

          {from ? (
            <HoldingsTokenList
              mode="pick"
              tokens={holdings.tokens}
              isLoading={holdings.isLoading}
              error={holdings.error?.message ?? null}
              emptyTitle="No ERC-20 holdings found"
              source={holdings.source}
              isSelected={(t) => walletsMatch(t.mintAddress, token)}
              onToggle={(t) => setToken(t.mintAddress)}
              onRetry={() => void holdings.refetchFresh()}
            />
          ) : null}

          {side === 'buy' ? (
            <label className="block text-xs text-gray-400">
              {quote} amount
              <input
                type="number"
                min="0"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white"
              />
            </label>
          ) : (
            <label className="block text-xs text-gray-400">
              Sell %
              <input
                type="number"
                min="1"
                max="100"
                value={sellPct}
                onChange={(e) => setSellPct(e.target.value)}
                className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white"
              />
            </label>
          )}

          <label className="block text-xs text-gray-400">
            Slippage (bps)
            <input
              type="number"
              min="1"
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value) || 200)}
              className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white"
            />
          </label>
          {isParent && getRhBatchExecutorAddress() ? (
            <p className="text-xs text-gray-500">{RH_PLATFORM_FEE_LABEL}</p>
          ) : null}

          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          {okMsg ? <p className="text-sm text-emerald-400">{okMsg}</p> : null}

          <button
            type="button"
            disabled={busy || !from}
            onClick={() => void openConfirm()}
            className="w-full rounded-xl bg-white py-3 font-semibold text-gray-900 disabled:bg-gray-600 disabled:text-gray-400"
          >
            {busy ? 'Quoting…' : side === 'buy' ? 'Review buy' : 'Review sell'}
          </button>
        </>
      ) : (
        <>
          <label className="block text-xs text-gray-400">
            From token address
            <input
              value={fromToken}
              onChange={(e) => setFromToken(e.target.value)}
              className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white font-mono text-sm"
              placeholder="0x…"
            />
          </label>

          <label className="block text-xs text-gray-400">
            To token address
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white font-mono text-sm"
              placeholder="0x…"
            />
          </label>

          {from ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-xs uppercase text-gray-500">From</p>
                <HoldingsTokenList
                  mode="pick"
                  tokens={holdings.tokens}
                  isLoading={holdings.isLoading}
                  error={holdings.error?.message ?? null}
                  emptyTitle="No ERC-20 holdings found"
                  source={holdings.source}
                  isSelected={(t) => walletsMatch(t.mintAddress, fromToken)}
                  onToggle={(t) => setFromToken(t.mintAddress)}
                  onRetry={() => void holdings.refetchFresh()}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs uppercase text-gray-500">To</p>
                <HoldingsTokenList
                  mode="pick"
                  tokens={holdings.tokens}
                  isLoading={holdings.isLoading}
                  error={holdings.error?.message ?? null}
                  emptyTitle="No ERC-20 holdings found"
                  isSelected={(t) => walletsMatch(t.mintAddress, token)}
                  onToggle={(t) => setToken(t.mintAddress)}
                  onRetry={() => void holdings.refetchFresh()}
                />
              </div>
            </div>
          ) : null}

          <label className="block text-xs text-gray-400">
            Sell %
            <input
              type="number"
              min="1"
              max="100"
              value={sellPct}
              onChange={(e) => setSellPct(e.target.value)}
              className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white"
            />
          </label>

          <label className="block text-xs text-gray-400">
            Slippage (bps)
            <input
              type="number"
              min="1"
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value) || 200)}
              className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white"
            />
          </label>
          {isParent && getRhBatchExecutorAddress() ? (
            <p className="text-xs text-gray-500">{RH_PLATFORM_FEE_LABEL}</p>
          ) : null}

          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          {okMsg ? <p className="text-sm text-emerald-400">{okMsg}</p> : null}

          <button
            type="button"
            disabled={busy || !from}
            onClick={() => void openConfirm()}
            className="w-full rounded-xl bg-white py-3 font-semibold text-gray-900 disabled:bg-gray-600 disabled:text-gray-400"
          >
            {busy
              ? 'Quoting…'
              : `Review ${fromToken.trim() ? 'swap' : 'token → token'}`}
          </button>
        </>
      )}
    </div>
  )
}
