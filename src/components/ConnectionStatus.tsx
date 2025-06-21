'use client'

import { useState, useEffect } from 'react'
import { useConnection } from './WalletProvider'
import WalletPoints from '@/components/WalletPoints'

export default function ConnectionStatus() {
  const { connection } = useConnection()
  const [status, setStatus] = useState<'checking' | 'connected' | 'error'>('checking')
  const [error, setError] = useState<string>('')
  const [slot, setSlot] = useState<number | null>(null)

  useEffect(() => {
    const checkConnection = async () => {
      try {
        setStatus('checking')
        setError('')
        
        // Test basic RPC call
        const currentSlot = await connection.getSlot('confirmed')
        setSlot(currentSlot)
        setStatus('connected')
      } catch (err) {
        console.error('Connection test failed:', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
        setStatus('error')
      }
    }

    checkConnection()
    
    // Check connection every 30 seconds
    const interval = setInterval(checkConnection, 30000)
    
    return () => clearInterval(interval)
  }, [connection])

  const getStatusColor = () => {
    switch (status) {
      case 'connected': return 'text-green-400'
      case 'error': return 'text-red-400'
      case 'checking': return 'text-yellow-400'
      default: return 'text-gray-400'
    }
  }

  const getStatusIcon = () => {
    switch (status) {
      case 'connected': return '●'
      case 'error': return '●'
      case 'checking': return '◐'
      default: return '○'
    }
  }

  return (
    <div className="flex items-center space-x-1 text-xs">
      <span className={`${getStatusColor()} animate-pulse`}>
        {getStatusIcon()}
      </span>
      <WalletPoints />
      <span className="text-gray-500 text-xs">
        {status === 'connected' && slot && `(solana is active)`}
        {status === 'checking' && `(checking connection...)`}
        {status === 'error' && `(connection failed)`}
      </span>
      {error && (
        <span className="text-red-400 text-xs ml-2" title={error}>
          ⚠️
        </span>
      )}
    </div>
  )
} 