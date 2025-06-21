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

  const renderBuyResult = (buyResult: BulkBuyResult) => (
    <div className="space-y-6">
      {/* Main Summary */}
      <div className={`border rounded-xl p-6 ${
        buyResult.success 
          ? 'bg-gray-800 border-gray-600' 
          : 'bg-gray-800 border-gray-600'
      }`}>
        <h3 className={`font-bold text-lg mb-3 ${buyResult.success ? 'text-white' : 'text-gray-300'}`}>
          {buyResult.success ? '✅ Purchase Completed!' : '❌ Purchase Failed'}
        </h3>
        
        {/* Balance Change Display */}
        {balanceBefore && balanceAfter && balanceBefore > 0 && balanceAfter > 0 && (
          <div className="mb-4 p-4 bg-gray-700 rounded-lg">
            <h4 className="text-sm font-semibold text-gray-200 mb-2">Wallet Balance Change</h4>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="block text-gray-400">Before</span>
                <span className="text-white font-mono">{balanceBefore.toFixed(4)} SOL</span>
              </div>
              <div>
                <span className="block text-gray-400">After</span>
                <span className="text-white font-mono">{balanceAfter.toFixed(4)} SOL</span>
              </div>
              <div>
                <span className="block text-gray-400">Difference</span>
                <span className="text-white font-mono">
                  {(balanceAfter - balanceBefore).toFixed(4)} SOL
                </span>
              </div>
            </div>
          </div>
        )}
        
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div className="text-white">
            <span className="block font-medium">Successful</span>
            <span className="text-xl font-bold">{buyResult.successfulPurchases.length}</span>
          </div>
          <div className="text-white">
            <span className="block font-medium">Failed</span>
            <span className="text-xl font-bold">{buyResult.failedPurchases.length}</span>
          </div>
          <div className="text-white md:col-span-1 col-span-2">
            <span className="block font-medium">Total Spent</span>
            <span className="text-xl font-bold">
              {balanceBefore && balanceAfter 
                ? Math.abs(balanceAfter - balanceBefore).toFixed(4)
                : '---'
              } SOL
            </span>
          </div>
        </div>
      </div>

      {/* Successful Purchases */}
      {buyResult.successfulPurchases.length > 0 && (
        <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
          <h4 className="font-semibold text-white mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Successful Purchases ({buyResult.successfulPurchases.length})
          </h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {buyResult.successfulPurchases.map((purchase, index) => (
              <div 
                key={index} 
                className="bg-gray-700 rounded-lg p-3 font-mono text-sm text-white border border-gray-600 cursor-pointer hover:border-gray-500"
                onClick={() => onSelectToken?.(purchase.mintAddress)}
              >
                <div className="flex justify-between items-center">
                  <span className="truncate mr-2">{purchase.mintAddress}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectToken?.(purchase.mintAddress)
                    }}
                    className="p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                  >
                    <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed Purchases */}
      {buyResult.failedPurchases.length > 0 && (
        <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
          <h4 className="font-semibold text-gray-300 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            Failed Purchases ({buyResult.failedPurchases.length})
          </h4>
          <div className="space-y-3 max-h-48 overflow-y-auto">
            {buyResult.failedPurchases.map((failure, index) => (
              <div 
                key={index} 
                className="bg-gray-700 rounded-lg p-3 border border-gray-600 cursor-pointer hover:border-gray-500"
                onClick={() => onSelectToken?.(failure.mintAddress)}
              >
                <div className="font-mono text-sm text-white mb-1 flex justify-between items-center">
                  <span className="truncate mr-2">{failure.mintAddress}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectToken?.(failure.mintAddress)
                    }}
                    className="p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                  >
                    <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                    </svg>
                  </button>
                </div>
                <div className="text-xs text-gray-400">{failure.error}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  const renderSellResult = (sellResult: BulkSellResult) => (
    <div className="space-y-6">
      {/* Main Summary */}
      <div className={`border rounded-xl p-6 backdrop-blur-sm ${
        sellResult.success
          ? 'bg-gradient-to-r from-green-900/50 to-emerald-800/50 border-green-500/50' 
          : 'bg-gradient-to-r from-red-900/50 to-red-800/50 border-red-500/50'
      }`}>
        <h3 className={`font-bold text-lg mb-3 ${sellResult.success ? 'text-green-200' : 'text-red-200'}`}>
          {sellResult.success ? '🎉 Sale Completed!' : '❌ Sale Failed'}
        </h3>
        
        {/* Balance Change Display */}
        {balanceBefore && balanceAfter && balanceBefore > 0 && balanceAfter > 0 && (
          <div className="mb-4 p-4 bg-black/20 rounded-lg">
            <h4 className="text-sm font-semibold text-green-200 mb-2">Wallet Balance Change</h4>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="block text-green-300">Before</span>
                <span className="text-green-100 font-mono">{balanceBefore.toFixed(6)} SOL</span>
              </div>
              <div>
                <span className="block text-green-300">After</span>
                <span className="text-green-100 font-mono">{balanceAfter.toFixed(6)} SOL</span>
              </div>
              <div>
                <span className="block text-green-300">SOL Gained</span>
                <span className="text-green-100 font-mono">
                  +{(balanceAfter - balanceBefore).toFixed(6)} SOL
                </span>
                <span className="block text-xs text-green-300">≈ ${solToUsd(balanceAfter - balanceBefore).toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div className={sellResult.success ? 'text-green-300' : 'text-red-300'}>
            <span className="block font-medium">Successful Sales</span>
            <span className="text-xl font-bold">{sellResult.successfulSwaps.length}</span>
          </div>
          <div className={sellResult.success ? 'text-green-300' : 'text-red-300'}>
            <span className="block font-medium">Failed Sales</span>
            <span className="text-xl font-bold">{sellResult.failedSwaps.length}</span>
          </div>
          <div className={sellResult.success ? 'text-green-300' : 'text-red-300'}>
            <span className="block font-medium">Accounts Closed</span>
            <span className="text-xl font-bold">{sellResult.successfulCloses.length}</span>
          </div>
          <div className={sellResult.success ? 'text-green-300' : 'text-red-300'}>
            <span className="block font-medium">Total SOL Gained</span>
            <span className="text-xl font-bold">
              {sellResult.successfulSwaps.reduce((total, swap) => total + swap.solReceived, 0).toFixed(6)}
            </span>
          </div>
        </div>
      </div>

      {/* Successful Sales */}
      {sellResult.successfulSwaps.length > 0 && (
        <div className="bg-gradient-to-r from-green-900/30 to-emerald-800/30 border border-green-500/30 rounded-xl p-6 backdrop-blur-sm">
          <h4 className="font-semibold text-green-200 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Successful Sales ({sellResult.successfulSwaps.length})
          </h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {sellResult.successfulSwaps.map((sale, index) => (
              <div key={index} className="bg-green-900/20 rounded-lg p-3 border border-green-500/20">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center">
                  <span className="font-mono text-sm text-green-100 mb-1 sm:mb-0 truncate mr-2">{sale.mintAddress}</span>
                  <div className="flex flex-col items-end">
                    <span className="text-green-200 font-semibold">{sale.solReceived.toFixed(6)} SOL</span>
                    <span className="text-xs text-green-300">≈ ${solToUsd(sale.solReceived).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed Sales */}
      {sellResult.failedSwaps.length > 0 && (
        <div className="bg-gradient-to-r from-red-900/30 to-red-800/30 border border-red-500/30 rounded-xl p-6 backdrop-blur-sm">
          <h4 className="font-semibold text-red-200 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            Failed Sales ({sellResult.failedSwaps.length})
          </h4>
          <div className="space-y-3 max-h-48 overflow-y-auto">
            {sellResult.failedSwaps.map((failure, index) => (
              <div key={index} className="bg-red-900/20 rounded-lg p-3 border border-red-500/20">
                <div className="font-mono text-sm text-red-100 mb-1 truncate">{failure.mintAddress}</div>
                <div className="text-xs text-red-300">{failure.error}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Account Closing Results */}
      {(sellResult.successfulCloses.length > 0 || sellResult.failedCloses.length > 0) && (
        <div className="bg-gradient-to-r from-blue-900/30 to-indigo-800/30 border border-blue-500/30 rounded-xl p-6 backdrop-blur-sm">
          <h4 className="font-semibold text-blue-200 mb-4 flex items-center">
            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Account Closing Results
          </h4>
          <div className="grid grid-cols-2 gap-4 text-sm mb-4">
            <div className="text-blue-300">
              <span className="block font-medium">Successfully Closed</span>
              <span className="text-xl font-bold text-blue-100">{sellResult.successfulCloses.length}</span>
            </div>
            <div className="text-blue-300">
              <span className="block font-medium">Failed to Close</span>
              <span className="text-xl font-bold text-blue-100">{sellResult.failedCloses.length}</span>
            </div>
          </div>
          {sellResult.failedCloses.length > 0 && (
            <div className="space-y-2 max-h-32 overflow-y-auto">
              <p className="text-blue-200 text-sm font-medium">Failed to close:</p>
              {sellResult.failedCloses.map((failure, index) => (
                <div key={index} className="bg-blue-900/20 rounded-lg p-2 border border-blue-500/20">
                  <div className="font-mono text-xs text-blue-100 truncate">{failure.mintAddress}</div>
                  <div className="text-xs text-blue-300">{failure.error}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )

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
                <h4 className="font-semibold text-slate-200 mb-4 flex items-center">
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Transaction Signatures ({signatures.length})
                </h4>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {signatures.map((sig, index) => (
                    <a
                      key={index}
                      href={`https://solscan.io/tx/${sig}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block bg-slate-700/30 hover:bg-slate-600/30 rounded-lg p-3 transition-colors border border-slate-600/30 hover:border-blue-500/30"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm text-slate-300 truncate mr-4">{sig}</span>
                        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
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