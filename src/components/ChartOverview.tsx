'use client'

import React, { useState } from 'react'

interface ChartOverviewProps {
  tokenAddress: string
  isOpen: boolean
  onClose: () => void
}

export default function ChartOverview({ tokenAddress, isOpen, onClose }: ChartOverviewProps) {
  const [isLoading, setIsLoading] = useState(true)

  // Create the Birdeye TV widget URL
  const birdeyeWidgetUrl = `https://birdeye.so/tv-widget/${tokenAddress}?chain=solana&viewMode=pair&chartInterval=1D&chartType=CANDLE&chartTimezone=Asia%2FSingapore&chartLeftToolbar=show&theme=dark`

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75">
      <div className="relative w-11/12 h-5/6 max-w-6xl bg-gray-900 rounded-xl overflow-hidden shadow-xl">
        {/* Close button */}
        <div className="absolute top-2 right-2 z-10">
          <button 
            onClick={onClose}
            className="bg-gray-800 text-gray-300 hover:text-white p-2 rounded-full shadow-lg"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        {/* Loading indicator */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-12 h-12 border-4 border-gray-400 border-t-white rounded-full animate-spin"></div>
          </div>
        )}
        
        {/* Birdeye TV widget iframe */}
        <iframe 
          src={birdeyeWidgetUrl}
          className="w-full h-full"
          style={{ 
            border: 'none',
            minHeight: '600px'
          }}
          title={`Birdeye Chart - ${tokenAddress}`}
          onLoad={() => setIsLoading(false)}
          allowFullScreen
          frameBorder="0"
        />
      </div>
    </div>
  )
}
