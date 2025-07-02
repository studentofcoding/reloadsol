'use client'

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { Connection as SolanaConnection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { clusterApiUrl } from '@solana/web3.js'
import { createConnection } from '@/utils/connection'

// Phantom wallet interface
interface PhantomProvider {
  isPhantom?: boolean
  publicKey?: PublicKey
  isConnected?: boolean
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>
  signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>
  connect(opts?: { onlyIfTrusted: boolean }): Promise<{ publicKey: PublicKey }>
  disconnect(): Promise<void>
  on(event: string, callback: Function): void
  removeListener(event: string, callback: Function): void
}

// Wallet context interface
interface WalletContextType {
  publicKey: PublicKey | null
  connected: boolean
  connecting: boolean
  signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>
  signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array }>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

declare global {
  interface Window {
    solana?: PhantomProvider
  }
}

// Create context
const WalletContext = createContext<WalletContextType | null>(null)

interface WalletProviderProps {
  children: React.ReactNode
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [provider, setProvider] = useState<PhantomProvider | null>(null)

  // Check for Phantom wallet
  useEffect(() => {
    const getProvider = () => {
      if ('solana' in window) {
        const phantom = window.solana
        if (phantom?.isPhantom) {
          setProvider(phantom)
          return phantom
        }
      }
      return null
    }

    const phantom = getProvider()
    
    if (phantom) {
      // Only try to auto-connect if we haven't explicitly disconnected
      const hasDisconnected = sessionStorage.getItem('hasDisconnected')
      if (!hasDisconnected) {
        phantom.connect({ onlyIfTrusted: true }).catch(() => {
          // Ignore error - user hasn't connected before
        })
      }
    }
  }, [])

  // Set up event listeners
  useEffect(() => {
    if (!provider) return

    const handleConnect = (publicKey: PublicKey) => {
      setPublicKey(publicKey)
      setConnected(true)
      setConnecting(false)
    }

    const handleDisconnect = () => {
      setPublicKey(null)
      setConnected(false)
      setConnecting(false)

      // Set flags to prevent auto-connect and redirect loop
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('justDisconnected', 'true')
        sessionStorage.setItem('hasDisconnected', 'true')
      }
    }

    const handleAccountChanged = (publicKey: PublicKey | null) => {
      if (publicKey) {
        setPublicKey(publicKey)
        setConnected(true)
      } else {
        handleDisconnect()
      }
    }

    provider.on('connect', handleConnect)
    provider.on('disconnect', handleDisconnect)
    provider.on('accountChanged', handleAccountChanged)

    // Check if already connected, but respect disconnect state
    const hasDisconnected = sessionStorage.getItem('hasDisconnected')
    if (!hasDisconnected && provider.isConnected && provider.publicKey) {
      handleConnect(provider.publicKey)
    }

    return () => {
      provider.removeListener('connect', handleConnect)
      provider.removeListener('disconnect', handleDisconnect)
      provider.removeListener('accountChanged', handleAccountChanged)
    }
  }, [provider])

  // Connect function
  const connect = async () => {
    if (!provider) {
      throw new Error('Phantom wallet not found! Please install Phantom wallet.')
    }

    setConnecting(true)
    try {
      // Clear any previous disconnect state when explicitly connecting
      sessionStorage.removeItem('hasDisconnected')
      
      const response = await provider.connect()
      setPublicKey(response.publicKey)
      setConnected(true)
    } catch (error) {
      console.error('Failed to connect to Phantom:', error)
      throw error
    } finally {
      setConnecting(false)
    }
  }

  // Disconnect function
  const disconnect = async () => {
    if (!provider) return

    try {
      await provider.disconnect()
      setPublicKey(null)
      setConnected(false)
    } catch (error) {
      console.error('Failed to disconnect from Phantom:', error)
    }
  }

  // Sign transaction
  const signTransaction = async <T extends Transaction | VersionedTransaction>(
    transaction: T
  ): Promise<T> => {
    if (!provider) throw new Error('Phantom wallet not connected')
    return await provider.signTransaction(transaction)
  }

  // Sign all transactions
  const signAllTransactions = async <T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> => {
    if (!provider) throw new Error('Phantom wallet not connected')
    return await provider.signAllTransactions(transactions)
  }

  // Sign message
  const signMessage = async (message: Uint8Array) => {
    if (!provider) throw new Error('Phantom wallet not connected')
    return await provider.signMessage(message)
  }

  const contextValue: WalletContextType = {
    publicKey,
    connected,
    connecting,
    signTransaction,
    signAllTransactions,
    signMessage,
    connect,
    disconnect,
  }

  return (
    <WalletContext.Provider value={contextValue}>
      <ConnectionProvider>
        {children}
      </ConnectionProvider>
    </WalletContext.Provider>
  )
}

// Hook to use wallet context
export function useWallet(): WalletContextType {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

// Use our custom connection utility
const ConnectionContext = createContext<any>(null)

interface ConnectionProviderProps {
  children: React.ReactNode
}

function ConnectionProvider({ children }: ConnectionProviderProps) {
  // Use our proxy-aware connection
  const connection = useMemo(() => createConnection('mainnet'), [])
  
  return (
    <ConnectionContext.Provider value={connection}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  const connection = useContext(ConnectionContext)
  if (!connection) {
    throw new Error('useConnection must be used within a ConnectionProvider')
  }
  return { connection }
} 