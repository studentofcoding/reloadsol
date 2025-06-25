'use client'

import React, { useEffect } from 'react'
import { BulkBuyResult } from '@/types'
import { BulkSellResult } from '@/utils/jupiter'

type CloseResult = {
  successful: string[]
  failed: Array<{ mintAddress: string; error: string }>
  signatures: string[]
}

type TransactionResultModalProps = {
  isOpen: boolean
  onClose: () => void
  operation: 'buy' | 'sell' | 'close'
  result: BulkBuyResult | BulkSellResult | CloseResult | null
  balanceBefore?: number
  balanceAfter?: number
  solToUsd?: (solValue: number) => number
  onSelectToken?: (mintAddress: string) => void
}

export default function TransactionResultModal({
  isOpen,
  onClose,
  operation,
  result,
  balanceBefore,
  balanceAfter,
  solToUsd = (sol) => sol * 145, // Default fallback
  onSelectToken
}: TransactionResultModalProps) {
  // Close modal on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = 'unset'
    }
  }, [isOpen, onClose])

  if (!isOpen || !result) return null

  const renderBuyResult = (buyResult: BulkBuyResult) => {
    // Extract successful token names/symbols for display
    const successfulTokens = buyResult.successfulPurchases.map(purchase => {
      // Try to extract token symbol from mint address (simplified approach)
      const shortAddress = purchase.mintAddress.substring(0, 4) + '...' + purchase.mintAddress.substring(-4)
      return shortAddress
    })

    // Calculate total points earned (simplified: 1 point per successful purchase)
    const totalPoints = buyResult.successfulPurchases.length

    return (
      <div className="space-y-6">
        {/* Congratulations Message */}
        <div className={`border rounded-xl p-8 text-center backdrop-blur-sm ${
          buyResult.success 
            ? 'bg-gradient-to-r from-blue-900/50 to-indigo-800/50 border-blue-500/50' 
            : 'bg-gradient-to-r from-red-900/50 to-red-800/50 border-red-500/50'
        }`}>
          <div className="text-6xl mb-4">🚀</div>
          <h3 className={`font-bold text-2xl mb-4 ${buyResult.success ? 'text-blue-200' : 'text-red-200'}`}>
            {buyResult.success ? 'Congratulations!' : 'Transaction Completed'}
          </h3>
          
          {buyResult.success && successfulTokens.length > 0 && (
            <div className="mb-6">
              <p className="text-lg text-blue-200 mb-2">
                You've successfully bought:
              </p>
              <div className="flex flex-wrap justify-center gap-2 mb-4">
                {successfulTokens.map((token, index) => (
                  <span key={index} className="bg-blue-800/30 text-blue-100 px-3 py-1 rounded-full text-sm font-mono">
                    {token}
                  </span>
                ))}
                {successfulTokens.length > 5 && (
                  <span className="bg-blue-800/30 text-blue-100 px-3 py-1 rounded-full text-sm">
                    +{successfulTokens.length - 5} more
                  </span>
                )}
              </div>
              
              {totalPoints > 0 && (
                <div className="bg-yellow-900/30 border border-yellow-500/30 rounded-lg p-4 inline-block">
                  <p className="text-yellow-200 text-lg font-semibold">
                    🏆 You earned <span className="text-2xl font-bold text-yellow-100">{totalPoints}</span> points!
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Failed Purchases (if any) */}
        {buyResult.failedPurchases.length > 0 && (
          <div className="bg-gradient-to-r from-red-900/30 to-red-800/30 border border-red-500/30 rounded-xl p-6 backdrop-blur-sm">
            <h4 className="font-semibold text-red-200 mb-4 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              Some tokens couldn't be purchased ({buyResult.failedPurchases.length})
            </h4>
            <div className="space-y-2 max-h-32 overflow-y-auto">
              {buyResult.failedPurchases.map((failure, index) => (
                <div 
                  key={index} 
                  className="bg-red-900/20 rounded-lg p-3 border border-red-500/20 cursor-pointer hover:border-red-400/30"
                  onClick={() => onSelectToken?.(failure.mintAddress)}
                >
                  <div className="font-mono text-sm text-red-100 mb-1 flex justify-between items-center">
                    <span className="truncate mr-2">
                      {failure.mintAddress.substring(0, 4)}...{failure.mintAddress.substring(-4)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectToken?.(failure.mintAddress)
                      }}
                      className="p-1 bg-red-800/50 rounded hover:bg-red-700/50 transition-colors"
                    >
                      <svg className="w-4 h-4 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                      </svg>
                    </button>
                  </div>
                  <div className="text-xs text-red-300">{failure.error}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderSellResult = (sellResult: BulkSellResult) => {
    // Extract successful token names/symbols for display
    const successfulTokens = sellResult.successfulSwaps.map(swap => {
      // Try to extract token symbol from mint address (simplified approach)
      // In a real app, you'd have token metadata to get proper names
      const shortAddress = swap.mintAddress.substring(0, 4) + '...' + swap.mintAddress.substring(-4)
      return shortAddress
    })

    // Calculate total points earned (simplified: 1 point per successful swap + close)
    const totalPoints = sellResult.successfulSwaps.length + sellResult.successfulCloses.length

    return (
      <div className="space-y-6">
        {/* Congratulations Message */}
        <div className={`border rounded-xl p-8 text-center backdrop-blur-sm ${
          sellResult.success
            ? 'bg-gradient-to-r from-green-900/50 to-emerald-800/50 border-green-500/50' 
            : 'bg-gradient-to-r from-red-900/50 to-red-800/50 border-red-500/50'
        }`}>
          <div className="text-6xl mb-4">🎉</div>
          <h3 className={`font-bold text-2xl mb-4 ${sellResult.success ? 'text-green-200' : 'text-red-200'}`}>
            {sellResult.success ? 'Congratulations!' : 'Transaction Completed'}
          </h3>
          
          {sellResult.success && successfulTokens.length > 0 && (
            <div className="mb-6">
              <p className="text-lg text-green-200 mb-2">
                You've successfully sold:
              </p>
              <div className="flex flex-wrap justify-center gap-2 mb-4">
                {successfulTokens.map((token, index) => (
                  <span key={index} className="bg-green-800/30 text-green-100 px-3 py-1 rounded-full text-sm font-mono">
                    {token}
                  </span>
                ))}
                {successfulTokens.length > 5 && (
                  <span className="bg-green-800/30 text-green-100 px-3 py-1 rounded-full text-sm">
                    +{successfulTokens.length - 5} more
                  </span>
                )}
              </div>
              
              {totalPoints > 0 && (
                <div className="bg-yellow-900/30 border border-yellow-500/30 rounded-lg p-4 inline-block">
                  <p className="text-yellow-200 text-lg font-semibold">
                    🏆 You earned <span className="text-2xl font-bold text-yellow-100">{totalPoints}</span> points!
                  </p>
                </div>
              )}
            </div>
          )}

          {/* SOL Gained Summary */}
          {balanceBefore && balanceAfter && balanceBefore > 0 && balanceAfter > 0 && sellResult.success && (
            <div className="bg-black/20 rounded-lg p-4 inline-block">
              <p className="text-green-300 text-sm mb-1">Total SOL Gained</p>
              <p className="text-green-100 font-mono text-xl font-bold">
                +{(balanceAfter - balanceBefore).toFixed(4)} SOL
              </p>
              <p className="text-green-300 text-sm">≈ ${solToUsd(balanceAfter - balanceBefore).toFixed(2)}</p>
            </div>
          )}
        </div>

        {/* Failed Transactions (if any) */}
        {sellResult.failedSwaps.length > 0 && (
          <div className="bg-gradient-to-r from-red-900/30 to-red-800/30 border border-red-500/30 rounded-xl p-6 backdrop-blur-sm">
            <h4 className="font-semibold text-red-200 mb-4 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              Some tokens couldn't be sold ({sellResult.failedSwaps.length})
            </h4>
            <div className="space-y-2 max-h-32 overflow-y-auto">
              {sellResult.failedSwaps.map((failure, index) => (
                <div key={index} className="bg-red-900/20 rounded-lg p-3 border border-red-500/20">
                  <div className="font-mono text-sm text-red-100 mb-1 truncate">
                    {failure.mintAddress.substring(0, 4)}...{failure.mintAddress.substring(-4)}
                  </div>
                  <div className="text-xs text-red-300">{failure.error}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderCloseResult = (closeResult: CloseResult) => (
    <div className="space-y-6">
      <div className={`border rounded-xl p-6 backdrop-blur-sm ${
        closeResult.successful.length > 0
          ? 'bg-gradient-to-r from-yellow-900/50 to-orange-800/50 border-yellow-500/50' 
          : 'bg-gradient-to-r from-red-900/50 to-red-800/50 border-red-500/50'
      }`}>
        <h3 className={`font-bold text-lg mb-3 ${closeResult.successful.length > 0 ? 'text-yellow-200' : 'text-red-200'}`}>
          {closeResult.successful.length > 0 ? '🎉 Accounts Closed!' : '❌ Account Closing Failed'}
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div className={closeResult.successful.length > 0 ? 'text-yellow-300' : 'text-red-300'}>
            <span className="block font-medium">Accounts Closed</span>
            <span className="text-xl font-bold">{closeResult.successful.length}</span>
          </div>
          <div className={closeResult.successful.length > 0 ? 'text-yellow-300' : 'text-red-300'}>
            <span className="block font-medium">Failed to Close</span>
            <span className="text-xl font-bold">{closeResult.failed.length}</span>
          </div>
          <div className={closeResult.successful.length > 0 ? 'text-yellow-300' : 'text-red-300'}>
            <span className="block font-medium">Rent Recovered</span>
            <span className="text-xl font-bold">~{(closeResult.successful.length * 0.00203928).toFixed(6)} SOL</span>
            <span className="block text-sm text-yellow-400">≈ ${solToUsd(closeResult.successful.length * 0.00203928).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Successful Closes */}
      {closeResult.successful.length > 0 && (
        <div className="bg-gradient-to-r from-yellow-900/30 to-orange-800/30 border border-yellow-500/30 rounded-xl p-6 backdrop-blur-sm">
          <h4 className="font-semibold text-yellow-200 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Successfully Closed Accounts ({closeResult.successful.length})
          </h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {closeResult.successful.map((mintAddress, index) => (
              <div key={index} className="bg-yellow-900/20 rounded-lg p-3 border border-yellow-500/20">
                <div className="flex justify-between items-center">
                  <span className="font-mono text-sm text-yellow-100 truncate mr-2">{mintAddress}</span>
                  <span className="text-yellow-200 text-xs">Account closed</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed Closes */}
      {closeResult.failed.length > 0 && (
        <div className="bg-gradient-to-r from-red-900/30 to-red-800/30 border border-red-500/30 rounded-xl p-6 backdrop-blur-sm">
          <h4 className="font-semibold text-red-200 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            Failed to Close Accounts ({closeResult.failed.length})
          </h4>
          <div className="space-y-3 max-h-48 overflow-y-auto">
            {closeResult.failed.map((failure, index) => (
              <div key={index} className="bg-red-900/20 rounded-lg p-3 border border-red-500/20">
                <div className="font-mono text-sm text-red-100 mb-1 truncate">{failure.mintAddress}</div>
                <div className="text-xs text-red-300">{failure.error}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  const signatures = result.signatures || []

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl shadow-2xl border border-gray-700 max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <h2 className="text-2xl font-bold text-white capitalize">
            {operation} Transaction Results
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-[calc(90vh-80px)]">
          <div className="p-6 space-y-6">
            {operation === 'buy' && renderBuyResult(result as BulkBuyResult)}
            {operation === 'sell' && renderSellResult(result as BulkSellResult)}
            {operation === 'close' && renderCloseResult(result as CloseResult)}

            {/* Transaction Signatures */}
            {signatures.length > 0 && (
              <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 border border-slate-600/50 rounded-xl p-6 backdrop-blur-sm">
                <h4 className="font-semibold text-slate-200 mb-4 flex items-center justify-center">
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Check the transaction signatures here
                </h4>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {signatures.map((sig, index) => (
                    <a
                      key={index}
                      href={`https://solscan.io/tx/${sig}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block bg-slate-700/30 hover:bg-slate-600/30 rounded-lg p-3 transition-colors border border-slate-600/30 hover:border-blue-500/30"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm text-slate-300 truncate mr-4">
                          {sig.substring(0, 8)}...{sig.substring(-8)}
                        </span>
                        <div className="flex items-center text-blue-400 text-sm">
                          <span className="mr-2">View on Solscan</span>
                          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-700 bg-gray-800">
          <button
            onClick={onClose}
            className="w-full py-3 px-4 bg-white hover:bg-gray-100 text-black font-semibold rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
} 