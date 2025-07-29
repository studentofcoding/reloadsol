'use client'

import { useState, useEffect } from 'react'
import { useWallet } from '@/components/WalletProvider'
import Link from 'next/link'

// Simplified Bulk Token Transfer Component
function BulkTokenTransferSection({ walletInfo, userId }: { walletInfo: any, userId: string }) {
  const [destinationWallet, setDestinationWallet] = useState('')
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set())
  const [transferring, setTransferring] = useState(false)
  const [transferResults, setTransferResults] = useState<any>(null)
  const [showResults, setShowResults] = useState(false)

  // Toggle token selection
  const toggleToken = (tokenAddress: string) => {
    const newSelected = new Set(selectedTokens)
    if (newSelected.has(tokenAddress)) {
      newSelected.delete(tokenAddress)
    } else {
      newSelected.add(tokenAddress)
    }
    setSelectedTokens(newSelected)
  }

  // Select all tokens
  const selectAll = () => {
    if (walletInfo?.tokens) {
      const allTokens = new Set(['SOL', ...walletInfo.tokens.map((t: any) => t.mint)])
      setSelectedTokens(allTokens)
    }
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedTokens(new Set())
  }

  // Execute bulk transfer
  const handleBulkTransfer = async () => {
    if (!destinationWallet.trim()) {
      alert('Please enter a destination wallet address')
      return
    }

    if (selectedTokens.size === 0) {
      alert('Please select at least one token to transfer')
      return
    }

    setTransferring(true)

    try {
      // Prepare bulk transfer requests
      const transfers = []
      
      // Add SOL transfer if selected
      if (selectedTokens.has('SOL') && walletInfo.solBalance > 0.01) {
        transfers.push({
          type: 'SOL',
          amount: walletInfo.solBalance - 0.01 // Keep 0.01 SOL for fees
        })
      }

      // Add token transfers
      if (walletInfo?.tokens) {
        walletInfo.tokens.forEach((token: any) => {
          if (selectedTokens.has(token.mint)) {
            transfers.push({
              type: 'TOKEN',
              amount: token.balance,
              mint: token.mint,
              decimals: token.decimals
            })
          }
        })
      }

      // Execute bulk transfer
      const response = await fetch('/api/embedded-wallet/transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          destinationWallet: destinationWallet.trim(),
          transfers
        })
      })

      const result = await response.json()
      
      if (response.ok) {
        setTransferResults(result)
        setShowResults(true)
      } else {
        alert(`Bulk transfer failed: ${result.error}`)
      }
    } catch (error) {
      console.error('Bulk transfer error:', error)
      alert('Bulk transfer failed. Please try again.')
    } finally {
      setTransferring(false)
    }
  }

  if (showResults) {
    const { results, summary } = transferResults
    
    return (
      <div className="bg-gray-800 rounded-lg p-6 mb-8">
        <h2 className="text-xl font-semibold mb-4">Bulk Transfer Results</h2>
        
        {/* Summary */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-700 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-blue-400">{summary.total}</div>
            <div className="text-sm text-gray-400">Total Transfers</div>
          </div>
          <div className="bg-gray-700 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-green-400">{summary.successful}</div>
            <div className="text-sm text-gray-400">Successful</div>
          </div>
          <div className="bg-gray-700 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-red-400">{summary.failed}</div>
            <div className="text-sm text-gray-400">Failed</div>
          </div>
        </div>

        {/* Detailed Results */}
        <div className="space-y-3 mb-6">
          {results.map((result: any, index: number) => (
            <div key={index} className={`p-4 rounded-lg border ${
              result.success 
                ? 'bg-green-900/20 border-green-600' 
                : 'bg-red-900/20 border-red-600'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                    result.success ? 'bg-green-400' : 'bg-red-400'
                  }`}></div>
                  <span className="font-medium">
                    {result.type === 'SOL' ? 'SOL' : `Token ${result.mint?.slice(0, 8)}...`}
                  </span>
                  <span className="ml-2 text-gray-400">
                    {result.amount} {result.type === 'SOL' ? 'SOL' : 'tokens'}
                  </span>
                </div>
                {result.success ? (
                  <span className="text-green-400 text-sm">✓ Success</span>
                ) : (
                  <span className="text-red-400 text-sm">✗ Failed</span>
                )}
              </div>
              {result.signature && (
                <div className="mt-2 text-xs text-gray-400">
                  <a 
                    href={`https://solscan.io/tx/${result.signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300"
                  >
                    View on Solscan: {result.signature.slice(0, 20)}...
                  </a>
                </div>
              )}
              {result.error && (
                <div className="mt-2 text-xs text-red-400">
                  Error: {result.error}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => {
              setShowResults(false)
              setTransferResults(null)
              setSelectedTokens(new Set())
              setDestinationWallet('')
            }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg transition-colors"
          >
            Transfer More Assets
          </button>
          <button
            onClick={() => window.location.reload()}
            className="flex-1 bg-gray-600 hover:bg-gray-700 text-white py-3 px-4 rounded-lg transition-colors"
          >
            Refresh Wallet
          </button>
        </div>
      </div>
    )
  }

  if (!walletInfo?.hasAssets) {
    return (
      <div className="bg-gray-800 rounded-lg p-6 mb-8">
        <h2 className="text-xl font-semibold mb-4">Bulk Token Transfer</h2>
        <div className="text-center py-8">
          <svg className="w-12 h-12 text-gray-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2M4 13h2m13-8l-4 4m0 0l-4-4m4 4V3" />
          </svg>
          <h3 className="text-lg font-semibold text-gray-400 mb-2">No Assets to Transfer</h3>
          <p className="text-gray-500 text-sm">
            Your wallet doesn't have any assets to transfer.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6 mb-8">
      <h2 className="text-xl font-semibold mb-4">Bulk Token Transfer</h2>
      
      <div className="space-y-6">
        {/* Destination Wallet Input */}
        <div>
          <label htmlFor="destinationWallet" className="block text-sm font-medium text-gray-300 mb-2">
            Destination Wallet Address
          </label>
          <input
            type="text"
            id="destinationWallet"
            value={destinationWallet}
            onChange={(e) => setDestinationWallet(e.target.value)}
            placeholder="Enter wallet address..."
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Token Selection */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-medium">Select Assets to Transfer</h3>
            <div className="flex gap-2">
              <button
                onClick={selectAll}
                className="text-blue-400 hover:text-blue-300 text-sm"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                className="text-gray-400 hover:text-gray-300 text-sm"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {/* SOL Balance */}
            {walletInfo.solBalance > 0.01 && (
              <div className="flex items-center p-3 bg-gray-700 rounded-lg">
                <input
                  type="checkbox"
                  id="sol-checkbox"
                  checked={selectedTokens.has('SOL')}
                  onChange={() => toggleToken('SOL')}
                  className="mr-3 w-4 h-4 text-blue-600 bg-gray-600 border-gray-500 rounded focus:ring-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">SOL</span>
                    <span className="text-gray-300">
                      {(walletInfo.solBalance - 0.01).toFixed(4)} SOL
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">
                    (Keeping 0.01 SOL for transaction fees)
                  </div>
                </div>
              </div>
            )}

            {/* Token Accounts */}
            {walletInfo.tokens?.map((token: any, index: number) => (
              <div key={token.mint} className="flex items-center p-3 bg-gray-700 rounded-lg">
                <input
                  type="checkbox"
                  id={`token-${index}`}
                  checked={selectedTokens.has(token.mint)}
                  onChange={() => toggleToken(token.mint)}
                  className="mr-3 w-4 h-4 text-blue-600 bg-gray-600 border-gray-500 rounded focus:ring-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {token.symbol || `${token.mint.slice(0, 8)}...`}
                    </span>
                    <span className="text-gray-300">
                      {token.balance} tokens
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 font-mono">
                    {token.mint}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Transfer Button */}
        <div className="flex gap-3">
          <button
            onClick={handleBulkTransfer}
            disabled={transferring || !destinationWallet.trim() || selectedTokens.size === 0}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white py-3 px-4 rounded-lg transition-colors font-semibold"
          >
            {transferring ? (
              <div className="flex items-center justify-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Processing Bulk Transfer...
              </div>
            ) : (
              `Bulk Transfer ${selectedTokens.size} Asset${selectedTokens.size !== 1 ? 's' : ''}`
            )}
          </button>
        </div>

        {/* Warning */}
        <div className="bg-yellow-900/20 border border-yellow-600 rounded-lg p-4">
          <div className="flex items-center mb-2">
            <svg className="w-5 h-5 text-yellow-400 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <h4 className="text-yellow-400 font-semibold">Important</h4>
          </div>
          <p className="text-yellow-200 text-sm">
            Bulk transfers will process all selected assets in sequence. Make sure you control the destination wallet. Transfers cannot be undone.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function WalletPage() {
  const { wallet, connected, publicKey, walletType } = useWallet()
  const [walletInfo, setWalletInfo] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  const isEmbeddedWallet = walletType === 'embedded'

  // Debug logging
  useEffect(() => {
    console.log('🔍 WalletPage Debug:', {
      connected,
      walletType,
      isEmbeddedWallet,
      walletName: wallet?.adapter?.name,
      embeddedWalletData: wallet?.embeddedWalletData ? 'present' : 'missing'
    })
  }, [connected, walletType, wallet])

  useEffect(() => {
    if (connected && isEmbeddedWallet && wallet?.embeddedWalletData?.userId) {
      loadWalletInfo()
    }
  }, [connected, isEmbeddedWallet, wallet?.embeddedWalletData?.userId])

  const loadWalletInfo = async () => {
    if (!wallet?.embeddedWalletData?.userId) return

    setLoading(true)
    try {
      const response = await fetch(`/api/embedded-wallet/migrate?userId=${wallet.embeddedWalletData.userId}`)
      if (response.ok) {
        const data = await response.json()
        setWalletInfo(data)
      }
    } catch (error) {
      console.error('Failed to load wallet info:', error)
    } finally {
      setLoading(false)
    }
  }

  if (!connected) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center py-20">
            <h1 className="text-3xl font-bold mb-4">Wallet Management</h1>
            <p className="text-gray-400 mb-8">
              Please connect your wallet to access wallet management features.
            </p>
            <Link 
              href="/"
              className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg transition-colors inline-block"
            >
              Go to Trading
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!isEmbeddedWallet) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center py-20">
            <h1 className="text-3xl font-bold mb-4">Wallet Management</h1>
            <p className="text-gray-400 mb-8">
              Wallet management features are only available for Crossmint embedded wallets.
            </p>
            <p className="text-gray-500 mb-8">
              You are currently connected with: {walletType === 'phantom' ? 'Phantom Wallet' : 'External wallet'}
            </p>
            <Link 
              href="/"
              className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg transition-colors inline-block"
            >
              Go to Trading
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Wallet Management</h1>
          <p className="text-gray-400">
            Manage your Crossmint embedded wallet and transfer assets in bulk.
          </p>
        </div>

        {/* Wallet Overview */}
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Wallet Overview</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-2">Wallet Type</h3>
              <p className="text-lg">Crossmint Embedded Wallet</p>
            </div>
            
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-2">Wallet Address</h3>
              <p className="text-lg font-mono text-blue-400">
                {publicKey?.toString().slice(0, 8)}...{publicKey?.toString().slice(-8)}
              </p>
            </div>

            {loading ? (
              <div className="col-span-2 text-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-400 mx-auto"></div>
                <p className="text-gray-400 mt-2">Loading wallet info...</p>
              </div>
            ) : walletInfo && (
              <>
                <div>
                  <h3 className="text-sm font-medium text-gray-400 mb-2">SOL Balance</h3>
                  <p className="text-lg">{walletInfo.solBalance.toFixed(4)} SOL</p>
                </div>
                
                <div>
                  <h3 className="text-sm font-medium text-gray-400 mb-2">Token Accounts</h3>
                  <p className="text-lg">{walletInfo.tokenCount} tokens</p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Bulk Token Transfer Section */}
        {walletInfo && wallet?.embeddedWalletData?.userId && (
          <BulkTokenTransferSection 
            walletInfo={walletInfo} 
            userId={wallet.embeddedWalletData.userId} 
          />
        )}

        {/* Other Actions */}
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Other Actions</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-6 bg-gray-700/50 rounded-lg opacity-50">
              <div className="flex items-center mb-3">
                <svg className="w-6 h-6 text-gray-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <h3 className="text-lg font-semibold text-gray-500">Export History</h3>
              </div>
              <p className="text-gray-500 text-sm">
                Export your transaction history and trading records. (Coming Soon)
              </p>
            </div>

            <div className="p-6 bg-gray-700/50 rounded-lg opacity-50">
              <div className="flex items-center mb-3">
                <svg className="w-6 h-6 text-gray-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <h3 className="text-lg font-semibold text-gray-500">Wallet Settings</h3>
              </div>
              <p className="text-gray-500 text-sm">
                Configure wallet preferences and security settings. (Coming Soon)
              </p>
            </div>
          </div>
        </div>

        {/* Important Information */}
        <div className="bg-blue-900/20 border border-blue-600 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-blue-400 mb-3">About Crossmint Embedded Wallets</h2>
          <div className="text-blue-200 space-y-2 text-sm">
            <p>• <strong>Custodial Security:</strong> Your wallet is secured using MPC (Multi-Party Computation) technology</p>
            <p>• <strong>No Private Keys:</strong> Private keys are not stored as single entities and cannot be exported</p>
            <p>• <strong>Bulk Transfers:</strong> Transfer multiple assets efficiently in a single operation</p>
            <p>• <strong>Always Accessible:</strong> Your Crossmint wallet remains accessible even after transfers</p>
          </div>
        </div>
      </div>
    </div>
  )
}