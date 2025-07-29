'use client'

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { Connection as SolanaConnection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
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

// Available wallets interface
interface AvailableWallets {
  phantom: boolean
  embedded: boolean
}

// Wallet context interface compatible with Jupiter Terminal
interface WalletContextType {
  publicKey: PublicKey | null
  connected: boolean
  connecting: boolean
  disconnecting: boolean
  wallet: any | null
  walletType: 'phantom' | 'embedded' | null
  mounted: boolean
  hydrated: boolean
  availableWallets: AvailableWallets
  preferredWallet: 'phantom' | 'embedded' | null
  signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>
  signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array }>
  connect: (walletType?: 'phantom' | 'embedded') => Promise<void>
  disconnect: () => Promise<void>
  switchWallet: (walletType: 'phantom' | 'embedded') => Promise<void>
  sendTransaction?: (transaction: Transaction | VersionedTransaction, connection: SolanaConnection, options?: any) => Promise<string>
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
  const [mounted, setMounted] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [provider, setProvider] = useState<PhantomProvider | null>(null)
  const [wallet, setWallet] = useState<any>(null)
  const [walletType, setWalletType] = useState<'phantom' | 'embedded' | null>(null)
  const [availableWallets, setAvailableWallets] = useState<AvailableWallets>({ phantom: false, embedded: false })
  const [preferredWallet, setPreferredWallet] = useState<'phantom' | 'embedded' | null>(null)

  // Handle mounting and hydration safety
  useEffect(() => {
    setMounted(true)
    // Add a small delay to ensure hydration is complete
    const timer = setTimeout(() => {
      setHydrated(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Detect available wallets and auto-connect (only when hydrated)
  useEffect(() => {
    if (!mounted || !hydrated) return

    const detectAvailableWallets = async () => {
      console.log('🔍 Starting wallet detection...')
      const wallets = { phantom: false, embedded: false }

      // Check for embedded wallet
      const embeddedWallet = localStorage.getItem('embeddedWallet')
      console.log('🔍 Checking for embedded wallet in localStorage:', embeddedWallet ? 'Found' : 'Not found')
      if (embeddedWallet) {
        try {
          const walletData = JSON.parse(embeddedWallet)
          console.log('📋 Embedded wallet data:', walletData)
          if (walletData.publicKey) {
            wallets.embedded = true
            console.log('✅ Detected embedded wallet with publicKey:', walletData.publicKey)
          } else {
            console.log('❌ Embedded wallet data missing publicKey')
          }
        } catch (error) {
          console.error('❌ Failed to parse embedded wallet data:', error)
        }
      }

      // Check for Phantom wallet
      if (typeof window !== 'undefined' && window.solana) {
        const phantom = window.solana
        console.log('👻 Found window.solana:', phantom)
        if (phantom?.isPhantom) {
          wallets.phantom = true
          setProvider(phantom)
          console.log('✅ Detected Phantom wallet')
        } else {
          console.log('❌ window.solana exists but isPhantom is false')
        }
      } else {
        console.log('❌ No window.solana found')
      }

      console.log('🎯 Final wallet detection results:', wallets)
      setAvailableWallets(wallets)
      
      // Load user preference
      const savedPreference = localStorage.getItem('preferredWallet') as 'phantom' | 'embedded' | null
      console.log('💾 Saved preference:', savedPreference)
      let walletToAutoConnect: 'phantom' | 'embedded' | null = null
      
      if (savedPreference && wallets[savedPreference]) {
        setPreferredWallet(savedPreference)
        walletToAutoConnect = savedPreference
        console.log('✅ Loaded preferred wallet:', savedPreference)
      } else if (wallets.phantom && wallets.embedded) {
        // If both available but no preference, don't auto-connect
        console.log('🔄 Both wallets available, waiting for user choice')
        return wallets
      } else if (wallets.phantom) {
        setPreferredWallet('phantom')
        walletToAutoConnect = 'phantom'
        console.log('🎯 Only Phantom available, setting as preferred')
      } else if (wallets.embedded) {
        setPreferredWallet('embedded')
        walletToAutoConnect = 'embedded'
        console.log('🎯 Only Embedded available, setting as preferred')
        
        // If this is a newly detected embedded wallet, ensure it gets connected
        const newEmbeddedWallet = sessionStorage.getItem('newEmbeddedWallet')
        if (newEmbeddedWallet === 'true') {
          console.log('🆕 Newly created embedded wallet detected, will force auto-connect')
        }
      } else {
        console.log('❌ No wallets available')
      }

      // Auto-connect to preferred wallet if available and not explicitly disconnected
      if (walletToAutoConnect) {
        setTimeout(() => {
          const hasDisconnected = sessionStorage.getItem('hasDisconnected')
          const disconnectedWallet = sessionStorage.getItem('disconnectedWallet')
          const newEmbeddedWallet = sessionStorage.getItem('newEmbeddedWallet')
          const redirectedFromHome = sessionStorage.getItem('redirectedFromHome')
          
          console.log('🔄 Auto-connect check:', {
            walletToAutoConnect,
            hasDisconnected,
            disconnectedWallet,
            newEmbeddedWallet,
            redirectedFromHome,
            walletAvailable: wallets[walletToAutoConnect]
          })
          
          // For newly created embedded wallets or redirected from home, always auto-connect
          const shouldAutoConnect = wallets[walletToAutoConnect] && (
            newEmbeddedWallet === 'true' || // Always connect newly created embedded wallets
            redirectedFromHome === 'true' || // Always connect when redirected from home
            (!hasDisconnected && disconnectedWallet !== walletToAutoConnect) // Normal auto-connect logic
          )
          
          if (shouldAutoConnect) {
            console.log('🚀 Auto-connecting to preferred wallet:', walletToAutoConnect)
            
            // Clear the flags after attempting connection
            if (newEmbeddedWallet === 'true') {
              sessionStorage.removeItem('newEmbeddedWallet')
            }
            if (redirectedFromHome === 'true') {
              sessionStorage.removeItem('redirectedFromHome')
            }
            
            connectToWallet(walletToAutoConnect).catch(error => {
              console.error('❌ Auto-connection failed:', error)
              // Don't throw error for auto-connection failures
            })
          } else {
            console.log('⏸️ Skipping auto-connect - conditions not met')
          }
        }, 300) // Reduced timeout for faster connection
      }

      return wallets
    }

    detectAvailableWallets()
  }, [mounted, hydrated])

  // Helper function to connect to specific wallet type
  const connectToWallet = async (type: 'phantom' | 'embedded') => {
    if (!mounted || !hydrated) return

    // Check if the requested wallet type is actually available
    if (!availableWallets[type]) {
      throw new Error(`${type === 'phantom' ? 'Phantom' : 'Embedded'} wallet not available`)
    }

    try {
      setConnecting(true)
      
      if (type === 'embedded') {
        const embeddedWallet = localStorage.getItem('embeddedWallet')
        if (!embeddedWallet) throw new Error('Embedded wallet not found')
        
        const walletData = JSON.parse(embeddedWallet)
        setPublicKey(new PublicKey(walletData.publicKey))
        setConnected(true)
        setWalletType('embedded')
        setWallet({
          adapter: {
            name: 'Embedded Wallet',
            icon: '/logo.png',
            url: 'https://crossmint.com',
            publicKey: new PublicKey(walletData.publicKey),
            connected: true,
            connecting: false,
            disconnecting: false
          },
          embeddedWalletData: walletData
        })
        
        // Save preference
        localStorage.setItem('preferredWallet', 'embedded')
        setPreferredWallet('embedded')
        
      } else if (type === 'phantom') {
        // Double-check provider availability
        if (!provider) {
          console.error('Phantom provider not available')
          throw new Error('Phantom wallet not found')
        }
        
        const response = await provider.connect()
        setPublicKey(response.publicKey)
        setConnected(true)
        setWalletType('phantom')
        setWallet({
          adapter: {
            name: 'Phantom',
            icon: 'https://phantom.app/img/phantom-logo.svg',
            url: 'https://phantom.app',
            publicKey: response.publicKey,
            connected: true,
            connecting: false,
            disconnecting: false
          }
        })
        
        // Save preference
        localStorage.setItem('preferredWallet', 'phantom')
        setPreferredWallet('phantom')
      }
      
      // Clear disconnect flags
      sessionStorage.removeItem('hasDisconnected')
      sessionStorage.removeItem('disconnectedWallet')
      
    } catch (error) {
      console.error(`Failed to connect to ${type} wallet:`, error)
      throw error
    } finally {
      setConnecting(false)
    }
  }

  // Set up Phantom event listeners (only when hydrated)
  useEffect(() => {
    if (!mounted || !hydrated || !provider) return

    const handleConnect = (publicKey: PublicKey) => {
      if (walletType !== 'phantom') return // Only handle if we're expecting Phantom connection
      
      console.log('Phantom wallet connected:', publicKey.toString())
      setPublicKey(publicKey)
      setConnected(true)
      setConnecting(false)
      setDisconnecting(false)
      setWalletType('phantom')
      setWallet({
        adapter: {
          name: 'Phantom',
          icon: 'https://phantom.app/img/phantom-logo.svg',
          url: 'https://phantom.app',
          publicKey,
          connected: true,
          connecting: false,
          disconnecting: false
        }
      })
    }

    const handleDisconnect = () => {
      if (walletType !== 'phantom') return // Only handle if we're connected to Phantom
      
      console.log('Phantom wallet disconnected')
      setPublicKey(null)
      setConnected(false)
      setConnecting(false)
      setDisconnecting(false)
      setWallet(null)
      setWalletType(null)

      // Set wallet-specific disconnect flags
      sessionStorage.setItem('justDisconnected', 'true')
      sessionStorage.setItem('hasDisconnected', 'true')
      sessionStorage.setItem('disconnectedWallet', 'phantom')
    }

    const handleAccountChanged = (publicKey: PublicKey | null) => {
      if (walletType !== 'phantom') return
      
      if (publicKey) {
        setPublicKey(publicKey)
        setConnected(true)
        setWalletType('phantom')
      } else {
        handleDisconnect()
      }
    }

    provider.on('connect', handleConnect)
    provider.on('disconnect', handleDisconnect)
    provider.on('accountChanged', handleAccountChanged)

    return () => {
      provider.removeListener('connect', handleConnect)
      provider.removeListener('disconnect', handleDisconnect)
      provider.removeListener('accountChanged', handleAccountChanged)
    }
  }, [mounted, hydrated, provider, walletType])

  // Connect function with optional wallet type
  const connect = async (type?: 'phantom' | 'embedded') => {
    if (!mounted || !hydrated) return

    // If type specified, connect to that specific wallet
    if (type) {
      // Check availability before attempting connection
      if (!availableWallets[type]) {
        throw new Error(`${type === 'phantom' ? 'Phantom' : 'Embedded'} wallet not available`)
      }
      await connectToWallet(type)
      return
    }

    // If no type specified, use preferred wallet or show selection
    if (preferredWallet && availableWallets[preferredWallet]) {
      await connectToWallet(preferredWallet)
    } else {
      throw new Error('No wallet type specified and no preferred wallet available')
    }
  }

  // Switch wallet function
  const switchWallet = async (type: 'phantom' | 'embedded') => {
    if (!mounted || !hydrated) return
    if (!availableWallets[type]) {
      throw new Error(`${type} wallet not available`)
    }

    // Disconnect current wallet first
    if (connected) {
      await disconnect()
      // Small delay to ensure clean disconnect
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Connect to new wallet
    await connectToWallet(type)
  }

  // Disconnect function
  const disconnect = async () => {
    if (!mounted || !hydrated) return

    setDisconnecting(true)
    try {
      if (walletType === 'embedded') {
        // Don't remove embedded wallet data, just disconnect
        sessionStorage.setItem('disconnectedWallet', 'embedded')
      } else if (walletType === 'phantom' && provider) {
        await provider.disconnect()
        sessionStorage.setItem('disconnectedWallet', 'phantom')
      }
      
      setPublicKey(null)
      setConnected(false)
      setWallet(null)
      setWalletType(null)
      
      // Set general disconnect flag
      sessionStorage.setItem('hasDisconnected', 'true')
      sessionStorage.setItem('justDisconnected', 'true')
      
    } catch (error) {
      console.error('Failed to disconnect wallet:', error)
    } finally {
      setDisconnecting(false)
    }
  }

  // Sign transaction
  const signTransaction = async <T extends Transaction | VersionedTransaction>(
    transaction: T
  ): Promise<T> => {
    if (walletType === 'embedded') {
      throw new Error('Embedded wallet auto-signing not yet implemented')
    }
    
    if (!provider) throw new Error('Phantom wallet not connected')
    return await provider.signTransaction(transaction)
  }

  // Sign all transactions
  const signAllTransactions = async <T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> => {
    if (walletType === 'embedded') {
      throw new Error('Embedded wallet auto-signing not yet implemented')
    }
    
    if (!provider) throw new Error('Phantom wallet not connected')
    return await provider.signAllTransactions(transactions)
  }

  // Sign message
  const signMessage = async (message: Uint8Array) => {
    if (walletType === 'embedded') {
      throw new Error('Embedded wallet message signing not yet implemented')
    }
    
    if (!provider) throw new Error('Phantom wallet not connected')
    return await provider.signMessage(message)
  }

  // Send transaction for Jupiter Terminal compatibility
  const sendTransaction = async (
    transaction: Transaction | VersionedTransaction,
    connection: SolanaConnection,
    options?: any
  ): Promise<string> => {
    if (walletType === 'embedded') {
      throw new Error('Embedded wallet transaction sending not yet implemented')
    }
    
    if (!provider) throw new Error('Phantom wallet not connected')
    
    const signedTransaction = await provider.signTransaction(transaction)
    const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: options?.skipPreflight || false,
      preflightCommitment: options?.preflightCommitment || 'processed',
      ...options
    })
    
    return signature
  }

  const contextValue: WalletContextType = {
    publicKey,
    connected,
    connecting,
    disconnecting,
    wallet,
    walletType,
    mounted,
    hydrated,
    availableWallets,
    preferredWallet,
    signTransaction,
    signAllTransactions,
    signMessage,
    sendTransaction,
    connect,
    disconnect,
    switchWallet,
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