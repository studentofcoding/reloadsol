'use client'

import React, { useState } from 'react'
import {
  getGmgnKlineUrl,
  inferGmgnChain,
  type GmgnChain,
} from '@/utils/gmgn'

interface ChartOverviewProps {
  tokenAddress: string
  isOpen: boolean
  onClose: () => void
  /** GMGN chain for the embed. Robinhood uses GMGN; sol keeps Birdeye TV widget. */
  chain?: GmgnChain
}

export default function ChartOverview({
  tokenAddress,
  isOpen,
  onClose,
  chain,
}: ChartOverviewProps) {
  const [isLoading, setIsLoading] = useState(true)
  const resolvedChain = chain ?? inferGmgnChain(tokenAddress)

  const chartUrl =
    resolvedChain === 'robinhood'
      ? getGmgnKlineUrl(tokenAddress, {
          interval: '5',
          theme: 'dark',
          chain: 'robinhood',
        })
      : `https://birdeye.so/tv-widget/${tokenAddress}?chain=solana&viewMode=pair&chartInterval=1D&chartType=CANDLE&chartTimezone=Asia%2FSingapore&chartLeftToolbar=show&theme=dark`

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75">
      <div className="relative w-11/12 h-5/6 max-w-4xl bg-gray-900 rounded-xl overflow-hidden shadow-xl">
        <div className="absolute top-2 right-2 z-10">
          <button
            type="button"
            onClick={onClose}
            className="bg-gray-800 text-gray-300 hover:text-white p-2 rounded-full shadow-lg"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-12 h-12 border-4 border-gray-400 border-t-white rounded-full animate-spin"></div>
          </div>
        )}

        <iframe
          key={`${resolvedChain}-${tokenAddress}`}
          src={chartUrl}
          className="w-full h-full"
          style={{
            border: 'none',
            minHeight: '600px',
          }}
          title={`Chart - ${tokenAddress}`}
          onLoad={() => setIsLoading(false)}
          allowFullScreen
          frameBorder="0"
        />
      </div>
    </div>
  )
}
