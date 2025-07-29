'use client'

import React, { useState } from 'react'
import { useWallet, useConnection } from './WalletProvider'
import { Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'

export function EmbeddedWalletTest() {
  const { connected, walletType, publicKey, signTransaction, sendTransaction } = useWallet()
  const { connection } = useConnection()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string>('')

  const testAutoSigning = async () => {
    if (!connected || walletType !== 'embedded' || !publicKey) {
      setResult('❌ Embedded wallet not connected')
      return
    }

    setTesting(true)
    setResult('🔄 Testing auto-signing...')

    try {
      // Create a simple test transaction (transfer 0.001 SOL to self)
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: publicKey,
          lamports: 0.001 * LAMPORTS_PER_SOL
        })
      )

      // Get recent blockhash
      const { blockhash } = await connection.getLatestBlockhash()
      transaction.recentBlockhash = blockhash
      transaction.feePayer = publicKey

      setResult('🔄 Signing transaction...')

      // Test signing
      const signedTransaction = await signTransaction!(transaction)
      
      setResult('✅ Transaction signed successfully! Auto-signing is working.')
      
      console.log('Signed transaction:', signedTransaction)

    } catch (error: any) {
      console.error('Auto-signing test failed:', error)
      setResult(`❌ Auto-signing test failed: ${error.message}`)
    } finally {
      setTesting(false)
    }
  }

  if (!connected || walletType !== 'embedded') {
    return (
      <div className="p-4 bg-gray-100 rounded-lg">
        <h3 className="text-lg font-semibold mb-2">Embedded Wallet Auto-Sign Test</h3>
        <p className="text-gray-600">Connect with an embedded wallet to test auto-signing</p>
      </div>
    )
  }

  return (
    <div className="p-4 bg-blue-50 rounded-lg">
      <h3 className="text-lg font-semibold mb-2">Embedded Wallet Auto-Sign Test</h3>
      <p className="text-sm text-gray-600 mb-4">
        Connected: {publicKey?.toString().slice(0, 8)}...{publicKey?.toString().slice(-8)}
      </p>
      
      <button
        onClick={testAutoSigning}
        disabled={testing}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {testing ? 'Testing...' : 'Test Auto-Signing'}
      </button>
      
      {result && (
        <div className="mt-4 p-3 bg-white rounded border">
          <p className="text-sm">{result}</p>
        </div>
      )}
    </div>
  )
}