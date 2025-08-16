'use client'

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { Connection as SolanaConnection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { createConnection } from '@/utils/connection'
import { PrivyProvider, usePrivy, useSolanaWallets } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'

// Type declaration for Phantom wallet
declare global {
  interface Window {
    phantom?: {
      solana?: {
        isPhantom?: boolean
        connect?: () => Promise<{ publicKey: { toString: () => string } }>
        disconnect?: () => Promise<void>
        signTransaction?: (transaction: any) => Promise<any>
        signAllTransactions?: (transactions: any[]) => Promise<any[]>
        signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array }>
      }
    }
  }
}

// Wallet context interface compatible with Jupiter Terminal
interface WalletContextType {
  publicKey: PublicKey | null
  connected: boolean
  connecting: boolean
  disconnecting: boolean
  wallet: any | null
  signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>
  connect?: () => Promise<void>
  disconnect?: () => Promise<void>
}

// Create context
const WalletContext = createContext<WalletContextType | null>(null)

interface WalletProviderProps {
  children: React.ReactNode
}

// Client-side only wrapper to prevent hydration issues
function ClientOnlyWrapper({ children }: { children: React.ReactNode }) {
  const [hasMounted, setHasMounted] = useState(false)

  useEffect(() => {
    setHasMounted(true)
  }, [])

  if (!hasMounted) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin"></div>
      </div>
    )
  }

  return <>{children}</>
}

export function WalletProvider({ children }: WalletProviderProps) {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_PRIVY || 'https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn'
  
  // Configure Solana wallet connectors
  const solanaConnectors = useMemo(() => toSolanaWalletConnectors({
    // shouldAutoConnect: true, // Removed to prevent double initialization
  }), [])

  const getPrivyAppId = () => {
    if (process.env.NODE_ENV === 'production') {
      return process.env.PRIVY_APP_ID_PROD || process.env.NEXT_PUBLIC_PRIVY_APP_ID_PROD || 'cmc93cu77004xlb0n4uc72i27';
    }
    return process.env.PRIVY_APP_ID_DEV  || process.env.NEXT_PUBLIC_PRIVY_APP_ID_DEV || 'cmc93cu77004xlb0n4uc72i27';
  };

  return (
    <ClientOnlyWrapper>
      <PrivyProvider
        appId={getPrivyAppId()}
        config={{
          appearance: {
            walletChainType: 'solana-only',
            walletList: [
              'detected_wallets', // This is crucial - auto-detects installed browser extensions
              'phantom',
              'solflare', 
              'backpack',
              'wallet_connect'
            ]
          },
          embeddedWallets: {
            createOnLogin: 'users-without-wallets',
            showWalletUIs: false,
            priceDisplay: { primary: 'native-token', secondary: null }
          },
          externalWallets: {
            solana: {
              connectors: solanaConnectors,
            },
          },
          solanaClusters: [{name: 'mainnet-beta', rpcUrl: rpcUrl}],
          // Add timeout and retry configuration
          loginMethods: ['wallet'],
        }}
      >
        <WalletContextProvider>
          <ConnectionProvider>
            {children}
          </ConnectionProvider>
        </WalletContextProvider>
      </PrivyProvider>
    </ClientOnlyWrapper>
  )
}

// Inner component that uses Privy hooks with proper error handling
function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [wallet, setWallet] = useState<any>(null)
  const [privyError, setPrivyError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  // Safely use Privy hooks with error handling
  let ready = false
  let authenticated = false
  let user = null
  let wallets: any[] = []
  let login: any = null
  let logout: any = null

  try {
    const privyState = usePrivy()
    const solanaWallets = useSolanaWallets()
    
    ready = privyState.ready
    authenticated = privyState.authenticated
    user = privyState.user
    login = privyState.login
    logout = privyState.logout
    wallets = solanaWallets.wallets

    // Enhanced logging for debugging
    console.log('Privy State Debug:', {
      ready,
      authenticated,
      userExists: !!user,
      walletsCount: wallets.length,
      walletTypes: wallets.map(w => w.walletClientType),
      phantomDetected: typeof window !== 'undefined' && window.phantom?.solana?.isPhantom
    })
  } catch (error) {
    console.error('Privy hooks error:', error)
    setPrivyError('Failed to initialize Privy')
    ready = true
  }

  // Get the first available Solana wallet (embedded or external)
  const activeWallet = wallets.length > 0 ? wallets[0] : null
  
  useEffect(() => {
    if (privyError) {
      console.warn('Privy error detected, wallet functionality limited')
      return
    }

    if (ready && authenticated && activeWallet?.address) {
      try {
        const pubKey = new PublicKey(activeWallet.address)
        setPublicKey(pubKey)
        setConnected(true)
        setAuthError(null) // Clear any previous auth errors
        setWallet({
          adapter: {
            name: activeWallet.walletClientType === 'privy' ? 'Privy Embedded Wallet' : 'External Wallet',
            icon: 'https://privy.io/favicon.ico',
            url: 'https://privy.io',
            publicKey: pubKey,
            connected: true,
            connecting: false,
            disconnecting: false
          }
        })
        console.log('✅ Connected to Solana wallet via Privy:', {
          address: activeWallet.address,
          clientType: activeWallet.walletClientType,
          chainType: 'solana'
        })
      } catch (error) {
        console.error('❌ Invalid Solana address from Privy:', error)
        setAuthError('Invalid wallet address received')
      }
    } else if (ready && !authenticated) {
      // User is not authenticated, clear wallet state
      setPublicKey(null)
      setConnected(false)
      setWallet(null)
      console.log('🔌 User not authenticated, wallet state cleared')
    }
  }, [ready, authenticated, activeWallet, privyError])

  // Enhanced Privy-based wallet functions with better error handling
  const connect = async () => {
    if (!login) {
      console.error('❌ Login function not available')
      setAuthError('Login function not available')
      return
    }

    try {
      setConnecting(true)
      setAuthError(null)
      
      console.log('🔄 Attempting wallet connection...')
      console.log('Environment:', process.env.NODE_ENV)
      console.log('Domain:', typeof window !== 'undefined' ? window.location.origin : 'SSR')
      
      const result = await login({
        loginMethods: ['wallet'],
        walletChainType: 'solana-only',
        disableSignup: false
      })
      
      console.log('✅ Login attempt completed:', result)
    } catch (error) {
      console.error('❌ Wallet connection failed:', error)
      
      // Enhanced error handling for specific cases
      if (error instanceof Error) {
        if (error.message.includes('403') || error.message.includes('Forbidden')) {
          setAuthError('Domain not configured in Privy dashboard. Please contact support.')
        } else if (error.message.includes('User rejected')) {
          setAuthError('Connection was cancelled by user')
        } else if (error.message.includes('Wallet not found')) {
          setAuthError('Phantom wallet not found. Please install Phantom extension.')
        } else {
          setAuthError(`Connection failed: ${error.message}`)
        }
      } else {
        setAuthError('Unknown connection error occurred')
      }
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async () => {
    if (!logout) {
      console.error('❌ Logout function not available')
      return
    }

    try {
      setDisconnecting(true)
      setAuthError(null)
      console.log('🔄 Disconnecting wallet...')
      await logout()
      console.log('✅ Wallet disconnected successfully')
    } catch (error) {
      console.error('❌ Disconnect failed:', error)
      setAuthError('Failed to disconnect wallet')
    } finally {
      setDisconnecting(false)
    }
  }

  const signTransaction = async <T extends Transaction | VersionedTransaction>(
    transaction: T
  ): Promise<T> => {
    if (!activeWallet) throw new Error('No active wallet')
    return await activeWallet.signTransaction(transaction)
  }

  const signAllTransactions = async <T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> => {
    if (!activeWallet) throw new Error('No active wallet')
    return await activeWallet.signAllTransactions(transactions)
  }

  const signMessage = async (message: Uint8Array) => {
    if (!activeWallet) throw new Error('No active wallet')
    return await activeWallet.signMessage(message)
  }

  const sendTransaction = async (
    transaction: Transaction | VersionedTransaction,
    connection: SolanaConnection,
    options?: any
  ): Promise<string> => {
    const signedTransaction = await signTransaction(transaction)
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
    signTransaction,
    signAllTransactions,
    connect,
    disconnect
  }

  // Display auth errors to help with debugging
  useEffect(() => {
    if (authError) {
      console.warn('🚨 Authentication Error:', authError)
      // You could also show a toast notification here
    }
  }, [authError])

  return (
    <WalletContext.Provider value={contextValue}>
      {children}
      {/* Optional: Add error display for debugging */}
      {authError && process.env.NODE_ENV === 'development' && (
        <div style={{
          position: 'fixed',
          top: '10px',
          right: '10px',
          background: 'red',
          color: 'white',
          padding: '10px',
          borderRadius: '5px',
          zIndex: 9999,
          maxWidth: '300px'
        }}>
          Auth Error: {authError}
        </div>
      )}
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletContextType {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

// Connection provider remains the same
const ConnectionContext = createContext<any>(null)

interface ConnectionProviderProps {
  children: React.ReactNode
}

function ConnectionProvider({ children }: ConnectionProviderProps) {
  const connection = useMemo(() => {
    return createConnection()
  }, [])

  return (
    <ConnectionContext.Provider value={connection}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  const context = useContext(ConnectionContext)
  if (!context) {
    throw new Error('useConnection must be used within a ConnectionProvider')
  }
  return context
}