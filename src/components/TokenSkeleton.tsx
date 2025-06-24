import React from 'react'

interface TokenSkeletonProps {
  count?: number
  variant?: 'default' | 'progressive' | 'trending' | 'trading-history' | 'token-chips'
  className?: string
}

const TokenSkeleton: React.FC<TokenSkeletonProps> = ({ 
  count = 10, 
  variant = 'default',
  className = ''
}) => {
  const renderDefaultSkeleton = () => (
    <div className={`grid gap-3 max-h-96 overflow-y-auto ${className}`}>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="group p-4 rounded-xl border bg-gray-800 border-gray-600 animate-pulse"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {/* Logo skeleton */}
              <div className="w-10 h-10 rounded-full bg-gray-600"></div>
              <div>
                {/* Token name skeleton */}
                <div className="h-4 bg-gray-600 rounded w-24 mb-2"></div>
                {/* Token symbol skeleton */}
                <div className="h-3 bg-gray-700 rounded w-16"></div>
              </div>
            </div>
            <div className="text-right">
              {/* Balance skeleton */}
              <div className="h-4 bg-gray-600 rounded w-20 mb-1"></div>
              {/* USD value skeleton */}
              <div className="h-3 bg-gray-700 rounded w-16"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )

  const renderProgressiveSkeleton = () => (
    <div className={`grid gap-3 max-h-96 overflow-y-auto ${className}`}>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="group p-4 rounded-xl border bg-gray-800 border-gray-600 animate-pulse"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {/* Logo skeleton */}
              <div className="w-10 h-10 rounded-full bg-gray-600"></div>
              <div>
                {/* Token symbol skeleton */}
                <div className="h-3 bg-gray-700 rounded w-20 mb-1"></div>
              </div>
            </div>
            <div className="flex text-right">
              <div className="h-4 bg-gray-700 rounded w-20 mr-2"></div>
              <div className="h-4 bg-gray-600 rounded w-24"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )

  const renderTrendingSkeleton = () => (
    <div className={`space-y-3 max-h-[600px] overflow-y-auto pr-2 ${className}`}>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="p-4 bg-gray-800 rounded-xl border border-gray-700 animate-pulse"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-3">
              <div className="relative">
                {/* Logo skeleton */}
                <div className="w-10 h-10 bg-gray-600 rounded-full"></div>
                {/* Rank badge skeleton */}
                <div className="absolute -top-1 -right-1 w-5 h-5 bg-gray-700 rounded-full"></div>
              </div>
              <div>
                {/* Token symbol skeleton */}
                <div className="h-4 bg-gray-600 rounded w-16 mb-1"></div>
                {/* Time ago skeleton */}
                <div className="h-3 bg-gray-700 rounded w-12"></div>
              </div>
            </div>
            <div className="text-right">
              {/* Price skeleton */}
              <div className="h-4 bg-gray-600 rounded w-20 mb-1"></div>
              {/* 5m change skeleton */}
              <div className="h-3 bg-gray-700 rounded w-14"></div>
            </div>
          </div>
          <div className="flex justify-between text-xs mt-2">
            <div className="flex items-center space-x-4">
              {/* 1h change skeleton */}
              <div className="h-3 bg-gray-700 rounded w-16"></div>
              {/* Volume skeleton */}
              <div className="h-3 bg-gray-700 rounded w-20"></div>
            </div>
            {/* Chart button skeleton */}
            <div className="w-6 h-6 bg-gray-700 rounded"></div>
          </div>
        </div>
      ))}
    </div>
  )

  const renderTradingHistorySkeleton = () => (
    <div className={`flex space-x-0 overflow-x-auto mb-3 scrollbar-hide ${className}`}>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex-shrink-0 p-4 min-w-[180px] rounded-lg animate-pulse"
        >
          {/* Timestamp skeleton */}
          <div className="flex items-center justify-between text-xs mb-1">
            <div className="h-3 bg-gray-600 rounded w-16"></div>
            <div className="w-3 h-3 bg-gray-700 rounded"></div>
          </div>
          
          {/* Operation type and tokens skeleton */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="h-3 bg-gray-600 rounded w-8"></div>
              <div className="flex items-center space-x-1">
                {/* Token icons skeleton */}
                <div className="relative flex items-center">
                  {Array.from({ length: Math.min(4, index + 1) }).map((_, idx) => (
                    <div 
                      key={`${index}-${idx}`}
                      className="w-3 h-3 bg-gray-700 rounded-full"
                      style={{ marginLeft: idx > 0 ? '-0.5rem' : '0' }}
                    />
                  ))}
                </div>
                {/* Token symbols skeleton */}
                <div className="flex items-center space-x-1">
                  <div className="h-3 bg-gray-700 rounded w-12"></div>
                  <div className="h-3 bg-gray-700 rounded w-8"></div>
                </div>
              </div>
              {/* SOL amount skeleton */}
              <div className="h-3 bg-gray-600 rounded w-16"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )

  const renderTokenChipsSkeleton = () => (
    <div className={`max-h-[200px] overflow-y-auto ${className}`}>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: count }).map((_, index) => (
          <div
            key={index}
            className="flex items-center bg-gray-700 rounded-lg pl-2 pr-1 py-1 animate-pulse"
          >
            {/* Token icon skeleton */}
            <div className="w-5 h-5 mr-1 rounded-full bg-gray-600"></div>
            {/* Token name skeleton */}
            <div className="h-3 bg-gray-600 rounded w-16 mr-1"></div>
            {/* Token symbol skeleton */}
            <div className="h-3 bg-gray-700 rounded w-8 mr-1"></div>
            {/* Remove button skeleton */}
            <div className="w-5 h-5 bg-gray-600 rounded-full"></div>
          </div>
        ))}
      </div>
    </div>
  )

  switch (variant) {
    case 'progressive':
      return renderProgressiveSkeleton()
    case 'trending':
      return renderTrendingSkeleton()
    case 'trading-history':
      return renderTradingHistorySkeleton()
    case 'token-chips':
      return renderTokenChipsSkeleton()
    case 'default':
    default:
      return renderDefaultSkeleton()
  }
}

export default TokenSkeleton 