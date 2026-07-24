'use client'

import { useState } from 'react'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useTradingData } from '@/components/TradingDataProvider'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import {
  executeGmgnBulkBuy,
  executeGmgnBulkSell,
} from '@/utils/gmgn-bulk-trade'
import { gmgnNativeToken, isValidTradeTokenAddress } from '@/utils/gmgn-currencies'
import UniversalWalletButton from '@/components/UniversalWalletButton'

type Side = 'buy' | 'sell'

/** Single-leg GMGN swap for Robinhood (ETH ↔ token). */
export default function RhGmgnSwapPanel({
  initialToken = '',
}: {
  initialToken?: string
}) {
  const { network } = useAppNetwork()
  const { trackOperation } = useTradingData()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const from = bound.evm || rh.address

  const [side, setSide] = useState<Side>('buy')
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
      setError('Connect Rabby or bind a GMGN EVM wallet')
      return
    }
    const addr = token.trim()
    if (!isValidTradeTokenAddress('robinhood', addr)) {
      setError('Enter a valid Robinhood token address')
      return
    }
    setBusy(true)
    try {
      if (side === 'buy') {
        const human = parseFloat(amount)
        if (!Number.isFinite(human) || human <= 0) {
          throw new Error('Enter a valid ETH amount')
        }
        const { results, success } = await executeGmgnBulkBuy({
          chain: 'robinhood',
          from,
          amountHuman: human,
          inputToken: gmgnNativeToken('robinhood'),
          tokenMints: [{ tokenAddress: addr }],
          slippageBps,
        })
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
        const { results, success } = await executeGmgnBulkSell({
          chain: 'robinhood',
          from,
          legs: [{ tokenAddress: addr, percent: pct }],
          slippageBps,
        })
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
        GMGN single-leg · ETH ↔ token · bound EVM:{' '}
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
            {s === 'buy' ? 'Buy (ETH → token)' : 'Sell (token → ETH)'}
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

      {side === 'buy' ? (
        <label className="block text-xs text-gray-400">
          ETH amount
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
          value={slippageBps}
          onChange={(e) => setSlippageBps(Number(e.target.value) || 200)}
          className="mt-1 w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-white"
        />
      </label>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {okMsg ? <p className="text-sm text-emerald-400">{okMsg}</p> : null}

      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="w-full rounded-lg bg-white text-black font-semibold py-2.5 disabled:bg-gray-600 disabled:text-gray-400"
      >
        {busy ? 'Swapping…' : side === 'buy' ? 'Buy with ETH' : 'Sell for ETH'}
      </button>
    </div>
  )
}
