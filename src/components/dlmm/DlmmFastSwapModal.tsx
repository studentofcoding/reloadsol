'use client'

import { useDeferredValue, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { formatEther, parseUnits } from 'viem'
import { useQuery } from '@tanstack/react-query'
import {
  useConnection,
  useWallet,
  useWalletAddress,
} from '@/components/WalletProvider'
import UniversalWalletButton from '@/components/UniversalWalletButton'
import GmgnTradeConfirmModal, {
  type GmgnConfirmLeg,
} from '@/components/GmgnTradeConfirmModal'
import RhPermit2SetupSheet, {
  RhPermit2StatusBanner,
} from '@/components/rh/RhPermit2SetupSheet'
import { useTradingData } from '@/components/TradingDataProvider'
import { useRhWalletMode } from '@/contexts/RhWalletModeContext'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import { useRhPermit2Readiness } from '@/hooks/useRhPermit2Readiness'
import { useRhWalletTokens } from '@/hooks/useRhWalletTokens'
import { useWalletBalances } from '@/hooks/useWalletBalances'
import {
  executeGmgnBulkBuy,
} from '@/utils/gmgn-bulk-trade'
import { executeRhParentKyberBuy } from '@/utils/dlmm/rh-kyber-swap'
import { getRhBatchExecutorAddress, RH_PLATFORM_FEE_LABEL } from '@/utils/dlmm/rh-batch-executor'
import type { RhSwapQuote } from '@/utils/dlmm/rh-univ2-swap'
import { RH_USDG, RH_WETH } from '@/utils/dlmm/rh-univ2'
import {
  GMGN_RH_USDG,
  GMGN_RH_WETH,
  gmgnNativeToken,
  isValidTradeTokenAddress,
} from '@/utils/gmgn-currencies'
import { resolveRhActiveAddress } from '@/utils/rh-wallet-mode'
import {
  fetchEthUsdSpot,
  simulateRhBoundBuyLeg,
  simulateRhParentBuyLeg,
} from '@/utils/rh-trade-sim'
import {
  buildRhBuyToken,
  rhQuoteUsdPerUnit,
} from '@/utils/rh-trade-record'
import { fetchJupiterLiteQuote } from '@/utils/jupiter-lite-swap'
import { executeBulkBuy } from '@/utils/jupiter'
import { getSolPriceUSD, TOKENS } from '@/utils/solana'
import { trackBuy } from '@/utils/operations-api'
import type { AppNetwork } from '@/utils/app-network'
import type { BulkBuyRequest } from '@/types'

type SolQuote = 'SOL' | 'USDC'

export type DlmmFastSwapModalProps = {
  open: boolean
  onClose: () => void
  network: AppNetwork
  tokenAddress: string
  tokenSymbol?: string
  pairLabel?: string
}

function gmgnQuoteToken(quote: RhSwapQuote): string {
  if (quote === 'USDG') return GMGN_RH_USDG
  if (quote === 'WETH') return GMGN_RH_WETH
  return gmgnNativeToken('robinhood')
}

function short(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export default function DlmmFastSwapModal({
  open,
  onClose,
  network,
  tokenAddress,
  tokenSymbol,
  pairLabel,
}: DlmmFastSwapModalProps) {
  if (!open) return null
  return (
    <DlmmFastSwapModalBody
      onClose={onClose}
      network={network}
      tokenAddress={tokenAddress}
      tokenSymbol={tokenSymbol}
      pairLabel={pairLabel}
    />
  )
}

function DlmmFastSwapModalBody({
  onClose,
  network,
  tokenAddress,
  tokenSymbol,
  pairLabel,
}: Omit<DlmmFastSwapModalProps, 'open'>) {
  const isRh = network === 'robinhood'
  const { mode: rhMode } = useRhWalletMode()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const rhTokens = useRhWalletTokens()
  const fromRh = resolveRhActiveAddress(rhMode, rh.address, bound.evm)
  const isParent = rhMode === 'parent'
  const rhBatchExecutor = getRhBatchExecutorAddress()

  const { connected, publicKey, signAllTransactions } = useWallet()
  const { connection } = useConnection()
  const solAddress = useWalletAddress()
  const solBalances = useWalletBalances({
    connection,
    publicKey: publicKey ?? null,
    walletAddress: solAddress,
    enabled: Boolean(connected && publicKey && solAddress),
  })
  const { trackOperation } = useTradingData()

  const [rhQuote, setRhQuote] = useState<RhSwapQuote>('ETH')
  const [solQuote, setSolQuote] = useState<SolQuote>('SOL')
  const [pct, setPct] = useState(25)
  const [manualAmount, setManualAmount] = useState<string | null>(null)
  const [slippageBps] = useState(200)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [permit2SetupOpen, setPermit2SetupOpen] = useState(false)
  const [confirmLegs, setConfirmLegs] = useState<GmgnConfirmLeg[]>([])
  const permit2SetupTokens = useMemo(
    () =>
      isRh && isParent && rhBatchExecutor && rhQuote !== 'ETH'
        ? [
            {
              address: (rhQuote === 'USDG' ? RH_USDG : RH_WETH) as Address,
              symbol: rhQuote,
            },
          ]
        : [],
    [isRh, isParent, rhBatchExecutor, rhQuote],
  )
  const permit2Readiness = useRhPermit2Readiness({
    publicClient: isRh && isParent ? rh.getPublicClient() : null,
    account: isRh && isParent && fromRh ? (fromRh as Address) : null,
    tokens: permit2SetupTokens.map((token) => token.address),
    spender: rhBatchExecutor,
    enabled: isRh && isParent,
  })

  const quoteBalance = useMemo(() => {
    if (isRh) {
      if (rhQuote === 'ETH') {
        // filled via query below
        return null
      }
      const addr = rhQuote === 'USDG' ? RH_USDG : RH_WETH
      const t = rhTokens.tokens.find(
        (x) => x.mintAddress.toLowerCase() === addr.toLowerCase(),
      )
      return t?.uiAmount ?? t?.balance ?? 0
    }
    if (solQuote === 'SOL') return solBalances.walletBalance ?? 0
    return solBalances.usdcBalance ?? 0
  }, [isRh, rhQuote, rhTokens.tokens, solQuote, solBalances])

  const ethBalQuery = useQuery({
    queryKey: ['rh-eth-balance', fromRh],
    enabled: isRh && rhQuote === 'ETH' && Boolean(fromRh),
    staleTime: 15_000,
    queryFn: async () => {
      const wei = await rh.getPublicClient().getBalance({
        address: fromRh as Address,
      })
      return Number(formatEther(wei))
    },
  })

  const bal =
    isRh && rhQuote === 'ETH'
      ? (ethBalQuery.data ?? 0)
      : (quoteBalance ?? 0)

  const amountFromPct = useMemo(() => {
    if (!(bal > 0)) return ''
    const next = (bal * pct) / 100
    return next >= 1 ? next.toFixed(4) : next.toPrecision(4)
  }, [bal, pct])

  const amount = manualAmount ?? amountFromPct
  const deferredAmount = useDeferredValue(amount)

  const simQuery = useQuery({
    queryKey: [
      'dlmm-fast-swap-sim',
      network,
      tokenAddress,
      isRh ? rhQuote : solQuote,
      deferredAmount,
      isParent,
      fromRh,
    ],
    enabled:
      Boolean(tokenAddress) &&
      Boolean(deferredAmount) &&
      parseFloat(deferredAmount) > 0 &&
      (isRh ? Boolean(fromRh) : Boolean(solAddress)),
    staleTime: 8_000,
    queryFn: async () => {
      const human = parseFloat(deferredAmount)
      if (!Number.isFinite(human) || human <= 0) {
        throw new Error('Enter a valid amount')
      }
      if (isRh) {
        if (
          rhQuote === 'WETH' &&
          tokenAddress.toLowerCase() === RH_WETH.toLowerCase()
        ) {
          throw new Error('Cannot trade WETH against WETH')
        }
        if (!isValidTradeTokenAddress('robinhood', tokenAddress)) {
          throw new Error('Invalid token address')
        }
        const ethUsd = await fetchEthUsdSpot()
        const held = rhTokens.tokens.find(
          (x) => x.mintAddress.toLowerCase() === tokenAddress.toLowerCase(),
        )
        const sim = isParent
          ? await simulateRhParentBuyLeg({
              amountHuman: human,
              tokenAddress,
              quote: rhQuote,
              ethUsd,
              tokenDecimals: held?.decimals ?? 18,
            })
          : await simulateRhBoundBuyLeg({
              from: fromRh!,
              amountHuman: human,
              tokenAddress,
              quote: rhQuote,
              slippageBps,
              ethUsd,
              tokenDecimals: held?.decimals ?? 18,
            })
        return {
          fromUsd: sim.fromUsd,
          toUsd: sim.toUsd,
          priceImpactPct: sim.priceImpactPct,
          amountOutRaw: sim.amountOutRaw,
          ethUsd,
          label: `${human} ${rhQuote}${isParent ? ' · Kyber' : ' · GMGN'}`,
        }
      }
      const inputMint = solQuote === 'SOL' ? TOKENS.SOL : TOKENS.USDC
      const decimals = solQuote === 'SOL' ? 9 : 6
      const raw = parseUnits(String(human), decimals).toString()
      const q = await fetchJupiterLiteQuote(
        inputMint,
        tokenAddress,
        raw,
        slippageBps,
      )
      const solUsd = await getSolPriceUSD()
      const inHuman = Number(q.inAmount) / 10 ** decimals
      const fromUsd =
        solQuote === 'SOL' ? inHuman * solUsd : inHuman
      const impact = Number(q.priceImpactPct)
      const toUsd =
        Number.isFinite(impact) && fromUsd > 0
          ? fromUsd * (1 - impact / 100)
          : null
      return {
        fromUsd,
        toUsd,
        priceImpactPct: Number.isFinite(impact) ? impact : null,
        amountOutRaw: q.outAmount,
        label: `${human} ${solQuote} · Jupiter`,
      }
    },
  })

  async function openConfirm() {
    setError('')
    setOkMsg('')
    if (isRh && !fromRh) {
      setError(
        isParent
          ? 'Connect Rabby (parent wallet)'
          : 'Bind a GMGN EVM wallet or switch to Parent',
      )
      return
    }
    if (!isRh && (!connected || !publicKey)) {
      setError('Connect Solana wallet')
      return
    }
    const human = parseFloat(amount)
    if (!Number.isFinite(human) || human <= 0) {
      setError('Enter a valid amount')
      return
    }
    if (isRh && isParent && rhBatchExecutor) {
      const latest =
        permit2Readiness.data ?? (await permit2Readiness.refetch()).data
      if (!latest || latest.some((item) => item.status !== 'ready')) {
        setPermit2SetupOpen(true)
        return
      }
      await runConfirmed()
      return
    }
    setBusy(true)
    try {
      const data = simQuery.data ?? (await simQuery.refetch()).data
      if (!data) throw new Error('Simulation failed')
      setConfirmLegs([
        {
          tokenAddress,
          amountLabel: data.label,
          side: 'buy',
          estOut: data.amountOutRaw ?? undefined,
          fromUsd: data.fromUsd,
          toUsd: data.toUsd,
          priceImpactPct: data.priceImpactPct,
        },
      ])
      setConfirmOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runConfirmed() {
    setBusy(true)
    setError('')
    try {
      const human = parseFloat(amount)
      if (isRh) {
        if (!fromRh) throw new Error('No RH wallet')
        let results: Awaited<ReturnType<typeof executeGmgnBulkBuy>>['results']
        let success: boolean
        if (isParent) {
          const wc = await rh.getWalletClient()
          ;({ results, success } = await executeRhParentKyberBuy({
            publicClient: rh.getPublicClient(),
            walletClient: wc,
            account: fromRh as Address,
            amountHuman: human,
            tokenMints: [{ tokenAddress }],
            slippageBps,
            quote: rhQuote,
          }))
        } else {
          ;({ results, success } = await executeGmgnBulkBuy({
            chain: 'robinhood',
            from: fromRh,
            amountHuman: human,
            inputToken: gmgnQuoteToken(rhQuote),
            tokenMints: [{ tokenAddress }],
            slippageBps,
          }))
        }
        const ok = results.filter((r) => r.success)
        if (ok.length > 0) {
          const held = rhTokens.tokens.find(
            (x) => x.mintAddress.toLowerCase() === tokenAddress.toLowerCase(),
          )
          const simData = simQuery.data
          const ethUsd = simData && 'ethUsd' in simData ? (simData.ethUsd as number) : 0
          const usdPerUnit = rhQuoteUsdPerUnit(rhQuote, ethUsd)
          const built = ok.map((r) =>
            buildRhBuyToken({
              mintAddress: r.tokenAddress,
              symbol: tokenSymbol ?? held?.symbol,
              spentQuote: human,
              usdPerUnit,
              estOutRaw: r.estOut ?? simData?.amountOutRaw,
              tokenDecimals: held?.decimals ?? 18,
            }),
          )
          const totalUsd = built.reduce((s, b) => s + b.usdValue, 0)
          await trackOperation({
            walletAddress: fromRh,
            operationType: 'buy',
            chain: 'robinhood',
            tokens: built.map((b) => b.token),
            successCount: ok.length,
            failureCount: results.length - ok.length,
            totalTokens: results.length,
            solAmount: human,
            totalUsdValue: totalUsd > 0 ? totalUsd : undefined,
            solPriceUsd: usdPerUnit > 0 ? usdPerUnit : undefined,
            feesPaid: 0,
            signatures: ok
              .map((r) => r.orderId || r.hash)
              .filter((id): id is string => Boolean(id)),
            slippage: slippageBps / 100,
          })
        }
        if (!success) throw new Error(results[0]?.error || 'Swap failed')
      } else {
        if (!publicKey || !connection || !signAllTransactions) {
          throw new Error('Wallet not ready')
        }
        const request: BulkBuyRequest = {
          solAmount: human,
          tokenMints: [tokenAddress],
          slippage: slippageBps,
          priorityFee: 30_000,
          inputCurrency: solQuote,
        }
        const buyResult = await executeBulkBuy(
          request,
          publicKey.toString(),
          connection,
          signAllTransactions,
        )
        if (
          !buyResult.success ||
          buyResult.successfulPurchases.length === 0
        ) {
          throw new Error(
            buyResult.failedPurchases[0]?.error || 'Buy failed',
          )
        }
        void trackBuy(
          publicKey.toString(),
          buyResult.successfulPurchases.length,
          {
            failureCount: buyResult.failedPurchases.length,
            solAmount: human,
            tokenMints: [tokenAddress],
            signatures: buyResult.signatures,
          },
        )
      }
      setOkMsg('Buy confirmed')
      setConfirmOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const quoteLabel = isRh ? rhQuote : solQuote
  const sim = simQuery.data

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <GmgnTradeConfirmModal
        open={confirmOpen}
        chain={isRh ? 'robinhood' : 'sol'}
        from={(isRh ? fromRh : solAddress) || ''}
        legs={confirmLegs}
        busy={busy}
        sequentialSignHint={
          isRh && isParent && !getRhBatchExecutorAddress()
        }
        feeHint={
          isRh && isParent && getRhBatchExecutorAddress()
            ? RH_PLATFORM_FEE_LABEL
            : undefined
        }
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void runConfirmed()}
      />
      {fromRh ? (
        <RhPermit2SetupSheet
          open={permit2SetupOpen}
          onClose={() => setPermit2SetupOpen(false)}
          publicClient={rh.getPublicClient()}
          getWalletClient={rh.getWalletClient}
          account={fromRh as Address}
          spender={rhBatchExecutor}
          tokens={permit2SetupTokens}
          readiness={permit2Readiness.data}
          loading={permit2Readiness.isLoading || permit2Readiness.isFetching}
          error={permit2Readiness.isError}
          onRefresh={async () => (await permit2Readiness.refetch()).data}
        />
      ) : null}

      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-white font-bold text-lg">Fast swap</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {pairLabel || tokenSymbol || short(tokenAddress)} → buy
            </p>
            <p className="text-xs text-gray-600 font-mono break-all">
              {tokenAddress}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-sm"
          >
            ✕
          </button>
        </div>

        <div className="flex justify-end">
          <UniversalWalletButton />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {isRh
            ? (['ETH', 'USDG', 'WETH'] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setRhQuote(q)
                    setManualAmount(null)
                  }}
                  className={`px-2.5 py-1 text-xs font-mono rounded border ${
                    rhQuote === q
                      ? 'border-emerald-500 bg-emerald-950/40 text-emerald-300'
                      : 'border-gray-700 text-gray-400'
                  }`}
                >
                  {q}
                </button>
              ))
            : (['SOL', 'USDC'] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setSolQuote(q)
                    setManualAmount(null)
                  }}
                  className={`px-2.5 py-1 text-xs font-mono rounded border ${
                    solQuote === q
                      ? 'border-emerald-500 bg-emerald-950/40 text-emerald-300'
                      : 'border-gray-700 text-gray-400'
                  }`}
                >
                  {q}
                </button>
              ))}
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-gray-400">
            Amount ({quoteLabel})
            <input
              value={amount}
              onChange={(e) => setManualAmount(e.target.value)}
              className="mt-1 w-full bg-black border border-gray-700 text-white px-3 py-2 rounded text-sm font-mono"
              inputMode="decimal"
            />
          </label>
          <label className="block text-xs text-gray-400">
            {pct}% of balance ({bal > 0 ? bal.toPrecision(6) : '—'} {quoteLabel})
            <input
              type="range"
              min={1}
              max={100}
              value={pct}
              onChange={(e) => {
                setManualAmount(null)
                setPct(Number(e.target.value))
              }}
              className="w-full mt-1"
            />
          </label>
        </div>

        <div className="text-xs text-gray-400 border border-gray-800 rounded p-2 bg-black/40 space-y-1">
          {simQuery.isFetching ? (
            <div>Simulating…</div>
          ) : simQuery.error ? (
            <div className="text-red-400">
              {simQuery.error instanceof Error
                ? simQuery.error.message
                : 'Sim failed'}
            </div>
          ) : sim ? (
            <>
              <div>
                $
                {sim.fromUsd != null ? sim.fromUsd.toFixed(2) : '—'} → $
                {sim.toUsd != null ? sim.toUsd.toFixed(2) : '—'}
                {sim.priceImpactPct != null
                  ? ` · impact ${sim.priceImpactPct.toFixed(2)}%`
                  : ''}
              </div>
              <div className="text-gray-600">{sim.label}</div>
            </>
          ) : (
            <div>Enter amount to simulate</div>
          )}
        </div>

        {error ? (
          <p className="text-sm text-red-400 break-words">{error}</p>
        ) : null}
        {okMsg ? (
          <p className="text-sm text-emerald-400">{okMsg}</p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 border border-gray-700 text-gray-300 text-sm rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || simQuery.isFetching}
            onClick={() => void openConfirm()}
            className="flex-1 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 text-white text-sm rounded font-medium"
          >
            {busy ? '…' : 'Review'}
          </button>
        </div>
        {isRh && isParent && getRhBatchExecutorAddress() ? (
          <p className="text-xs text-gray-500 text-center">{RH_PLATFORM_FEE_LABEL}</p>
        ) : null}
        {isRh && isParent ? (
          <RhPermit2StatusBanner
            executorConfigured={Boolean(rhBatchExecutor)}
            readiness={permit2Readiness.data}
            loading={permit2Readiness.isLoading || permit2Readiness.isFetching}
            error={permit2Readiness.isError}
            onSetup={() => setPermit2SetupOpen(true)}
          />
        ) : null}
      </div>
    </div>
  )
}
