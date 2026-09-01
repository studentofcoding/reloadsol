'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useGmgnTokenSearch, useGmgnTrending, type GmgnSearchToken } from '@/hooks/useGmgnTokenSearch'
import { useRhWalletTokens } from '@/hooks/useRhWalletTokens'
import { useWalletTokens } from '@/hooks/useWalletTokens'
import { useResolvedWalletPublicKey } from '@/hooks/useResolvedWalletPublicKey'
import { useConnection } from '@/components/WalletProvider'
import { useRpc } from '@/contexts/RpcContext'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { OptimizedImage } from '@/components/OptimizedImage'
import GmgnKlineChart from '@/components/GmgnKlineChart'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'

type SearchTokenClientProps = {
  /** Pre-selected chain from the route segment. If absent, falls back to useAppNetwork().effectiveChain. */
  chain?: GmgnTradeChain
  /** Optional return target — surfaced as a "Done" button. */
  returnTo?: string
  /** Pre-fill the search box. */
  initialQuery?: string
}

const CHAIN_LABEL: Record<GmgnTradeChain, string> = {
  sol: 'Solana',
  robinhood: 'Robinhood',
}

function copy(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text)
  }
}

export default function SearchTokenClient(props: SearchTokenClientProps) {
  const { chain: chainProp, returnTo, initialQuery } = props
  const router = useRouter()
  const params = useSearchParams()
  const { effectiveChain: ctxChain } = useAppNetwork()
  const chain: GmgnTradeChain = chainProp ?? ctxChain
  const [query, setQuery] = useState(initialQuery ?? '')

  // Allow ?chain= override on the bare /search-token route.
  useEffect(() => {
    if (chainProp) return
    const raw = params?.get('chain')
    if (raw === 'sol' || raw === 'robinhood') {
      // Replace the path with the chain-specific deep-link for bookmarkability.
      router.replace(`/search-token/${raw}`)
    }
  }, [chainProp, params, router])

  return (
    <div className="space-y-4">
      <SearchTokenHeader chain={chain} returnTo={returnTo} />
      <SearchTokenInput
        value={query}
        onChange={setQuery}
        placeholder={`Search ${CHAIN_LABEL[chain]} tokens by name, symbol, or CA`}
      />
      <SearchTokenResults chain={chain} query={query} onPickAction={(action, token) => {
        const back = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ''
        if (action === 'add-to-buy') {
          router.push(`/buy/${chain}?mints=${encodeURIComponent(token.address)}${back}`)
        } else if (action === 'add-to-swap') {
          router.push(`/swap/${chain}?tokenMint=${encodeURIComponent(token.address)}`)
        }
      }} />
    </div>
  )
}

function SearchTokenHeader({ chain, returnTo }: { chain: GmgnTradeChain; returnTo?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-white">Search Token</h1>
        <span className="text-xs font-medium rounded-full bg-gray-800 border border-gray-700 px-2.5 py-1 text-gray-300">
          {CHAIN_LABEL[chain]}
        </span>
      </div>
      {returnTo ? (
        <Link
          href={returnTo}
          className="text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white px-3 py-1.5 rounded-lg"
        >
          Done
        </Link>
      ) : (
        <Link
          href={chain === 'robinhood' ? '/buy/robinhood' : '/buy/solana'}
          className="text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white px-3 py-1.5 rounded-lg"
        >
          Back
        </Link>
      )}
    </div>
  )
}

function SearchTokenInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-4 pr-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
      />
      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
        <svg className="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
            clipRule="evenodd"
          />
        </svg>
      </div>
    </div>
  )
}

type Action = 'add-to-buy' | 'add-to-swap'

function SearchTokenResults({
  chain,
  query,
  onPickAction,
}: {
  chain: GmgnTradeChain
  query: string
  onPickAction: (action: Action, token: GmgnSearchToken) => void
}) {
  const trimmed = query.trim()
  const search = useGmgnTokenSearch(chain, trimmed, { enabled: trimmed.length > 0 })
  const trending = useGmgnTrending(chain, trimmed.length === 0)
  const isRh = chain === 'robinhood'

  return (
    <div className="space-y-2">
      {trimmed.length > 0 ? (
        <ResultsList
          title={search.isFetching ? 'Searching…' : `Search Results (${search.data?.length ?? 0})`}
          tokens={search.data ?? []}
          empty={!search.isFetching && (search.data?.length ?? 0) === 0}
          chain={chain}
          onPickAction={onPickAction}
        />
      ) : (
        <>
          <ResultsList
            title={`Trending on ${CHAIN_LABEL[chain]}`}
            tokens={trending.data ?? []}
            empty={!trending.isFetching && (trending.data?.length ?? 0) === 0}
            chain={chain}
            onPickAction={onPickAction}
          />
          <YourHoldings chain={chain} onPickAction={onPickAction} />
        </>
      )}
    </div>
  )
}

function ResultsList({
  title,
  tokens,
  empty,
  chain,
  onPickAction,
}: {
  title: string
  tokens: GmgnSearchToken[]
  empty: boolean
  chain: GmgnTradeChain
  onPickAction: (action: Action, token: GmgnSearchToken) => void
}) {
  return (
    <div className="bg-gray-900/40 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-800 bg-gray-800/60">
        {title}
      </div>
      {empty ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">No results found.</div>
      ) : (
        <ul>
          {tokens.map((t) => (
            <ResultRow key={`${chain}-${t.address}`} token={t} chain={chain} onPickAction={onPickAction} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ResultRow({
  token,
  chain,
  onPickAction,
}: {
  token: GmgnSearchToken
  chain: GmgnTradeChain
  onPickAction: (action: Action, token: GmgnSearchToken) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const [showChart, setShowChart] = useState(false)
  return (
    <li className="border-b border-gray-800 last:border-b-0">
      <div className="flex items-center px-4 py-3 gap-3">
        {token.icon ? (
          <OptimizedImage
            src={token.icon}
            alt={token.symbol}
            className="w-8 h-8 rounded-full"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-700" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white truncate">
            {token.name} <span className="text-xs text-gray-400">({token.symbol})</span>
          </div>
          <div className="text-xs text-gray-400 font-mono truncate">{token.address}</div>
          {token.mcap ? (
            <div className="text-[11px] text-gray-500">MCap ${token.mcap.toLocaleString()}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowActions((v) => !v)}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white px-2.5 py-1 rounded"
          >
            Actions
          </button>
        </div>
      </div>
      {showActions ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          <ActionPill onClick={() => onPickAction('add-to-buy', token)}>Add to buy</ActionPill>
          <ActionPill onClick={() => onPickAction('add-to-swap', token)}>Add to swap</ActionPill>
          <ActionPill onClick={() => setShowChart((v) => !v)}>
            {showChart ? 'Hide chart' : 'View chart'}
          </ActionPill>
          <ActionPill onClick={() => copy(token.address)}>Copy CA</ActionPill>
        </div>
      ) : null}
      {showChart ? (
        <div className="px-4 pb-3">
          <GmgnKlineChart
            tokenMint={token.address}
            symbol={token.symbol}
            chain={chain}
          />
        </div>
      ) : null}
    </li>
  )
}

function ActionPill({
  children,
  onClick,
  href,
  external,
}: {
  children: ReactNode
  onClick?: () => void
  href?: string
  external?: boolean
}) {
  const className =
    'text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white px-2.5 py-1 rounded'
  if (href) {
    return (
      <Link
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className={className}
      >
        {children}
      </Link>
    )
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  )
}

function YourHoldings({
  chain,
  onPickAction,
}: {
  chain: GmgnTradeChain
  onPickAction: (action: Action, token: GmgnSearchToken) => void
}) {
  if (chain === 'robinhood') {
    return <RhHoldingsList onPickAction={onPickAction} />
  }
  return <SolHoldingsList onPickAction={onPickAction} />
}

function SolHoldingsList({
  onPickAction,
}: {
  onPickAction: (action: Action, token: GmgnSearchToken) => void
}) {
  const { publicKey, walletAddress, isWalletReady } = useResolvedWalletPublicKey()
  const { connection } = useConnection()
  const { activeRpcUrl } = useRpc()
  const { allTokens, isLoading } = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    activeRpcUrl,
    enabled: isWalletReady,
  })
  const top = useMemo(
    () =>
      allTokens
        .filter((t) => (t.usdValue ?? 0) > 0)
        .slice(0, 20)
        .map<GmgnSearchToken>((t) => ({
          id: t.mintAddress,
          address: t.mintAddress,
          name: t.name ?? t.symbol ?? t.mintAddress,
          symbol: t.symbol ?? '',
          icon: t.logoURI,
          mcap: undefined,
        })),
    [allTokens],
  )
  if (isLoading) return <Section title="Your holdings" loading />
  if (top.length === 0) return null
  return (
    <ResultsList
      title={`Your holdings (${top.length})`}
      tokens={top}
      empty={false}
      chain="sol"
      onPickAction={onPickAction}
    />
  )
}

function RhHoldingsList({
  onPickAction,
}: {
  onPickAction: (action: Action, token: GmgnSearchToken) => void
}) {
  const { tokens, isLoading } = useRhWalletTokens()
  const top = useMemo(
    () =>
      tokens
        .filter((t) => (t.usdValue ?? 0) > 0)
        .slice(0, 20)
        .map<GmgnSearchToken>((t) => ({
          id: t.mintAddress,
          address: t.mintAddress,
          name: t.name ?? t.symbol ?? t.mintAddress,
          symbol: t.symbol ?? '',
          icon: t.logoURI,
          mcap: undefined,
        })),
    [tokens],
  )
  if (isLoading) return <Section title="Your holdings" loading />
  if (top.length === 0) return null
  return (
    <ResultsList
      title={`Your holdings (${top.length})`}
      tokens={top}
      empty={false}
      chain="robinhood"
      onPickAction={onPickAction}
    />
  )
}

function Section({ title, loading }: { title: string; loading?: boolean }) {
  return (
    <div className="bg-gray-900/40 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-800 bg-gray-800/60">
        {title}
      </div>
      {loading ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">Loading…</div>
      ) : null}
    </div>
  )
}
