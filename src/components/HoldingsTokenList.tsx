'use client'

import ProgressiveTokenItem from '@/components/ProgressiveTokenItem'
import TokenSkeleton from '@/components/TokenSkeleton'
import type { UserToken } from '@/utils/jupiter'

export type HoldingsListMode = 'add' | 'select' | 'pick'

export default function HoldingsTokenList({
  tokens,
  mode,
  isLoading,
  error,
  emptyTitle = 'No tokens found',
  emptyHint,
  source,
  isSelected,
  selectedToken,
  onToggle,
  onSelectChart,
  onRefreshPrice,
  onUpdateSellPercentage,
  onUpdateSellAmount,
  onRetry,
}: {
  tokens: UserToken[]
  mode: HoldingsListMode
  isLoading?: boolean
  error?: string | null
  emptyTitle?: string
  emptyHint?: string
  source?: string
  isSelected: (token: UserToken) => boolean
  selectedToken?: (token: UserToken) => UserToken | undefined
  onToggle: (token: UserToken) => void
  onSelectChart?: (mintAddress: string) => void
  onRefreshPrice?: (token: UserToken) => void
  onUpdateSellPercentage?: (mintAddress: string, percentage: number) => void
  onUpdateSellAmount?: (mintAddress: string, tokenAmount: number) => void
  onRetry?: () => void
}) {
  const showSellControls = mode === 'select'

  if (isLoading && tokens.length === 0) {
    return <TokenSkeleton count={3} variant="progressive" />
  }

  if (error) {
    return (
      <div className="text-center py-8 border border-gray-600 rounded-xl">
        <p className="text-gray-400 mb-3">{error}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg text-sm"
          >
            Retry
          </button>
        ) : null}
      </div>
    )
  }

  if (tokens.length === 0) {
    return (
      <div className="text-center py-8 border border-gray-600 rounded-xl">
        <p className="text-lg font-semibold text-gray-300 mb-2">{emptyTitle}</p>
        {emptyHint ? <p className="text-gray-400 text-sm">{emptyHint}</p> : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg text-sm"
          >
            Refresh
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="grid max-h-96 overflow-y-auto border border-gray-600 rounded-xl">
      {source ? (
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-700">
          via {source}
        </div>
      ) : null}
      {tokens.map((token) => (
        <ProgressiveTokenItem
          key={token.mintAddress}
          token={token}
          isSelected={isSelected(token)}
          isLoading={false}
          showSellControls={showSellControls}
          onToggleSelection={onToggle}
          onSelectToken={onSelectChart}
          onRefreshPrice={onRefreshPrice}
          selectedToken={selectedToken?.(token)}
          onUpdateSellPercentage={
            showSellControls ? onUpdateSellPercentage : undefined
          }
          onUpdateSellAmount={showSellControls ? onUpdateSellAmount : undefined}
        />
      ))}
    </div>
  )
}
