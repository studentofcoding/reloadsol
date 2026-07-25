'use client'

import { useState } from 'react'
import type { Address } from 'viem'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useRhWalletMode } from '@/contexts/RhWalletModeContext'
import { useTradingData } from '@/components/TradingDataProvider'
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
import {
  GMGN_RH_USDG,
  GMGN_RH_WETH,
  gmgnNativeToken,
  isValidTradeTokenAddress,
} from '@/utils/gmgn-currencies'
import type { RhSwapQuote } from '@/utils/dlmm/rh-univ2-swap'
import { RH_WETH } from '@/utils/dlmm/rh-univ2'
import { resolveRhActiveAddress } from '@/utils/rh-wallet-mode'
import UniversalWalletButton from '@/components/UniversalWalletButton'

type Side = 'buy' | 'sell'

function gmgnQuoteToken(quote: RhSwapQuote): string {
  if (quote === 'USDG') return GMGN_RH_USDG
  if (quote === 'WETH') return GMGN_RH_WETH
  return gmgnNativeToken('robinhood')
}

/** Single-leg RH swap: Bound=GMGN server-sign, Parent=Kyber + Rabby. */
export default function RhGmgnSwapPanel({
  initialToken = '',
}: {
  initialToken?: string
}) {
  const { network } = useAppNetwork()
  const { mode: rhMode } = useRhWalletMode()
  const { trackOperation } = useTradingData()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const from = resolveRhActiveAddress(rhMode, rh.address, bound.evm)
  const isParent = rhMode === 'parent'
  const holdings = useRhWalletTokens()

  const [side, setSide] = useState<Side>('buy')
  const [quote, setQuote] = useState<RhSwapQuote>('ETH')
  const [token, setToken] = useState(initialToken)
  const [amount, setAmount] = useState('0.01')
  const [sellPct, setSellPct] = useState('100')
  const [slippageBps, setSlippageBps] = useState(200)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  if (network !== 'robinhood') return null

  const run = async () => {
    setError('')
    setOkMsg('')
    if (!from) {
      setError(
        isParent
          ? 'Connect Rabby (parent wallet)'
          : 'Bind a GMGN EVM wallet or switch to Parent',
      )
      return
    }
    const addr = token.trim()
    if (!isValidTradeTokenAddress('robinhood', addr)) {
      setError('Enter a valid Robinhood token address')
      return
    }
    if (
      quote === 'WETH' &&
      addr.toLowerCase() === RH_WETH.toLowerCase()
    ) {
      setError('Cannot trade WETH against WETH')
      return
    }
    setBusy(true)
    try {
      if (side === 'buy') {
        const human = parseFloat(amount)
        if (!Number.isFinite(human) || human <= 0) {
          throw new Error(`Enter a valid ${quote} amount`)
        }
        let results: Awaited<ReturnType<typeof executeGmgnBulkBuy>>['results']
        let success: boolean
        if (isParent) {
          const wc = await rh.getWalletClient()
          ;({ results, success } = await executeRhParentKyberBuy({
            publicClient: rh.publicClient,
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
        if (ok.length > 0) {
          await trackOperation({
            walletAddress: from,
            operationType: 'buy',
            chain: 'robinhood',
            tokens: [{ mintAddress: addr }],
            successCount: ok.length,
            failureCount: results.length - ok.length,
            totalTokens: results.length,
            solAmount: human,
            feesPaid: 0,
            signatures: ok
              .map((r) => r.orderId || r.hash)
              .filter((id): id is string => Boolean(id)),
            slippage: slippageBps / 100,
          })
        }
        if (!success) throw new Error(results[0]?.error || 'Swap failed')
        setOkMsg('Buy confirmed')
      } else {
        const pct = parseFloat(sellPct)
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          throw new Error('Sell % must be 1–100')
        }
        let results: Awaited<ReturnType<typeof executeGmgnBulkSell>>['results']
        let success: boolean
        if (isParent) {
          const wc = await rh.getWalletClient()
          ;({ results, success } = await executeRhParentKyberSell({
            publicClient: rh.publicClient,
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
        if (ok.length > 0) {
          await trackOperation({
            walletAddress: from,
            operationType: 'sell',
            chain: 'robinhood',
            tokens: [{ mintAddress: addr }],
            successCount: ok.length,
            failureCount: results.length - ok.length,
            totalTokens: results.length,
            feesPaid: 0,
            signatures: ok
              .map((r) => r.orderId || r.hash)
              .filter((id): id is string => Boolean(id)),
            slippage: slippageBps / 100,
          })
        }
        if (!success) throw new Error(results[0]?.error || 'Swap failed')
        setOkMsg('Sell confirmed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full max-w-md mx-auto rounded-2xl border border-gray-700 bg-gray-900/80 p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Robinhood Swap</h2>
        <UniversalWalletButton />
      </div>
      <p className="text-xs text-gray-400">
        {isParent ? 'Kyber · Rabby sign' : 'GMGN · bound server-sign'} ·{' '}
        {quote} ↔ token ·{' '}
        <span className="font-mono text-gray-300">
          {from ? `${from.slice(0, 6)}…${from.slice(-4)}` : 'none'}
        </span>
      </p>

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

      {from && holdings.tokens.length > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase text-gray-500">
            <span>Holdings</span>
            {holdings.source ? <span>via {holdings.source}</span> : null}
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-gray-700 p-1.5">
            {holdings.tokens.slice(0, 40).map((t) => {
              const usd =
                t.usdValue > 0
                  ? `$${t.usdValue.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}`
                  : '$—'
              const active =
                token.trim().toLowerCase() === t.mintAddress.toLowerCase()
              return (
                <button
                  key={t.mintAddress}
                  type="button"
                  onClick={() => setToken(t.mintAddress)}
                  className={`w-full flex items-center justify-between rounded-md px-2 py-1.5 text-left text-xs ${
                    active
                      ? 'bg-white text-black'
                      : 'bg-gray-800/80 text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  <span className="font-medium truncate">
                    {t.symbol || '???'}
                  </span>
                  <span className={active ? 'text-gray-700' : 'text-gray-400'}>
                    {usd}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : from && holdings.isLoading ? (
        <p className="text-xs text-gray-500">Loading holdings…</p>
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

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {okMsg ? <p className="text-sm text-emerald-400">{okMsg}</p> : null}

      <button
        type="button"
        disabled={busy || !from}
        onClick={() => void run()}
        className="w-full rounded-xl bg-white py-3 font-semibold text-gray-900 disabled:bg-gray-600 disabled:text-gray-400"
      >
        {busy ? 'Swapping…' : side === 'buy' ? 'Confirm buy' : 'Confirm sell'}
      </button>
    </div>
  )
}
