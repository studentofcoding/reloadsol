import React from 'react'
import { UserToken } from '@/utils/jupiter'

interface ProgressiveTokenItemProps {
  token: UserToken
  isSelected: boolean
  isLoading?: boolean
  onToggleSelection: (token: UserToken) => void
  onSelectToken?: (mintAddress: string) => void
  onRefreshPrice?: (token: UserToken) => void
  selectedToken?: any
  onUpdateSellPercentage?: (mintAddress: string, percentage: number) => void
  onUpdateSellAmount?: (mintAddress: string, tokenAmount: number) => void
}

const ProgressiveTokenItem: React.FC<ProgressiveTokenItemProps> = ({
  token,
  isSelected,
  isLoading = false,
  onToggleSelection,
  onSelectToken,
  onRefreshPrice,
  selectedToken,
  onUpdateSellPercentage,
  onUpdateSellAmount
}) => {
  const hasBasicData = token.symbol !== 'Unknown' || token.name !== 'Unknown Token'
  const hasLogo = token.logoURI && token.logoURI !== ''
  const hasPrice = token.usdValue > 0
  
  return (
    <div
      className={`group p-2 m-1 rounded-lg transition-all duration-200 border-b-2 pb-3 border-gray-800 ${
        isSelected
          ? 'bg-gray-700'
          : 'bg-gray-900'
      }`}
    >
      <div 
        className="flex items-center justify-between cursor-pointer"
        onClick={() => onToggleSelection(token)}
      >
        <div className="flex items-center space-x-3">
          {/* Checkbox */}
          <div className="flex items-center justify-center">
            <div className={`w-4 h-4 sm:w-4 sm:h-4 rounded border-2 flex items-center justify-center transition-colors ${
              isSelected 
                ? 'bg-blue-500 border-blue-500' 
                : 'border-gray-500 hover:border-gray-400'
            }`}>
              {isSelected && (
                <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
            </div>
          </div>

          {/* Logo with progressive loading */}
          <div className={`w-4 h-4 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-white font-bold ${
            isSelected ? 'bg-white text-black' : 'bg-gray-600'
          }`}>
            {isLoading ? (
              <div className="w-3 h-3 sm:w-6 sm:h-6 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
            ) : hasLogo ? (
              <img 
                src={token.logoURI} 
                alt={token.name} 
                className="w-4 h-4 sm:w-8 sm:h-8 rounded-full"
                onError={(e) => {
                  // Fallback to letter if image fails to load
                  const target = e.target as HTMLImageElement
                  target.onerror = null
                  target.style.display = 'none'
                  const parent = target.parentElement as HTMLElement | null
                  if (parent) {
                    parent.textContent = (token.symbol || 'T').charAt(0)
                  }
                }}
              />
            ) : (
              <span className={hasBasicData ? '' : 'animate-pulse'}>
                {(token.symbol || 'T').charAt(0)}
              </span>
            )}
          </div>
          
          <div>
            {/* Token name with progressive loading */}
            <div className="font-semibold text-gray-300 flex items-center">
              {isLoading ? (
                <div className="h-4 bg-gray-600 rounded w-24 animate-pulse"></div>
              ) : hasBasicData ? (
                <>
                  {token.symbol || 'Unknown'}
                  {onSelectToken && (
                  <button 
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectToken(token.mintAddress)
                    }}
                    className="ml-2 p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                    title="View Chart"
                  >
                    <svg className="w-3 h-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                    </svg>
                  </button>
                )}
                </>
              ) : (
                <div className="flex items-center space-x-2">
                  <span className="text-gray-400">Loading...</span>
                  <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
                </div>
              )}
            </div>
          </div>
        </div>
        
        <div className="text-right">
          {/* Balance */}
          <div className="font-semibold text-sm text-gray-400">
            {isLoading ? (
              <div className="h-4 bg-gray-600 rounded w-20 animate-pulse"></div>
            ) : (
              <>
                <span className="hidden sm:inline">{token.uiAmount.toFixed(6)}</span>
                {/* <span className="sm:hidden">{token.uiAmount.toFixed(0)}</span> */}
                {/* Price with progressive loading */}
                {token.isLoadingPrice ? (
                  <div className="flex items-center space-x-1 mt-1">
                    <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
                  </div>
                ) : hasPrice ? (
                  <>
                    <span className="ml-1 text-sm text-white">≈ ${token.usdValue.toFixed(2)}</span>
                  </>
                ) : (
                  <div className="text-xs text-gray-500 mt-1 flex items-center">
                    <div className="w-2 h-2 border border-gray-500 border-t-gray-300 rounded-full animate-spin mr-1"></div>
                    Getting price...
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      
      {/* Sell Amount Controls (visible when selected) */}
      {isSelected && selectedToken && onUpdateSellPercentage && (
        <div className="mt-4 pt-3 border-t border-gray-600">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-300">Sell Amount</span>
            <span className="text-sm text-gray-400">
              {selectedToken.sellPercentage}% = {(selectedToken.sellAmount / Math.pow(10, token.decimals)).toFixed(6)} tokens
            </span>
          </div>
          <div className="flex items-center space-x-3">
            <input
              type="range"
              min="1"
              max="100"
              value={selectedToken.sellPercentage}
              onChange={(e) => {
                e.stopPropagation()
                onUpdateSellPercentage(token.mintAddress, parseInt(e.target.value))
              }}
              className="flex-1 h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            />
            <input
              type="number"
              min="1"
              max="100"
              value={selectedToken.sellPercentage}
              onChange={(e) => {
                e.stopPropagation()
                const value = Math.max(1, Math.min(100, parseInt(e.target.value) || 1))
                onUpdateSellPercentage(token.mintAddress, value)
              }}
              className="w-16 px-2 py-1 bg-gray-600 text-white text-sm rounded border border-gray-500 focus:border-gray-400"
              onClick={(e) => e.stopPropagation()}
            />
            <span className="text-sm text-gray-400">%</span>
            {onUpdateSellAmount && (
              <>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={selectedToken.sellAmount / Math.pow(10, token.decimals)}
                  onChange={(e) => {
                    e.stopPropagation()
                    const value = parseFloat(e.target.value)
                    if (!isNaN(value)) {
                      onUpdateSellAmount(token.mintAddress, value)
                    }
                  }}
                  className="w-28 px-2 py-1 bg-gray-600 text-white text-sm rounded border border-gray-500 focus:border-gray-400"
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="text-sm text-gray-400">tokens</span>
              </>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
            <span>≈ ${(token.usdValue * selectedToken.sellPercentage / 100).toFixed(2)}</span>
            <span className={`px-2 py-1 rounded text-xs font-medium ${
              selectedToken.sellPercentage === 100 
                ? 'bg-yellow-600 text-yellow-100' 
                : 'bg-blue-600 text-blue-100'
            }`}>
              {selectedToken.sellPercentage === 100 ? 'Sell & Close' : 'Sell Only'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProgressiveTokenItem