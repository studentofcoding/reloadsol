'use client'

import React, { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { Connection as SolanaConnection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { createConnection } from '@/utils/connection'
import { PrivyProvider, usePrivy, useSolanaWallets } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'

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

export function WalletProvider({ children }: WalletProviderProps) {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_PRIVY || 'https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn'
  
  // Configure Solana wallet connectors
  const solanaConnectors = toSolanaWalletConnectors({
    shouldAutoConnect: true,
  })

  return (
    <PrivyProvider
      appId="cmc93cu77004xlb0n4uc72i27"
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
        solanaClusters: [{name: 'mainnet-beta', rpcUrl: rpcUrl}]
      }}
    >
      <WalletContextProvider>
        <ConnectionProvider>
          {children}
        </ConnectionProvider>
      </WalletContextProvider>
    </PrivyProvider>
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
  } catch (error) {
    console.error('Privy hooks error:', error)
    setPrivyError('Failed to initialize Privy')
    // Fallback to ready state to prevent infinite loading
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
        console.log('Connected to Solana wallet via Privy:', {
          address: activeWallet.address,
          clientType: activeWallet.walletClientType,
          chainType: 'solana'
        })
      } catch (error) {
        console.error('Invalid Solana address from Privy:', error)
      }
    } else if (ready && !authenticated) {
      // User is not authenticated, clear wallet state
      setPublicKey(null)
      setConnected(false)
      setWallet(null)
    }
  }, [ready, authenticated, activeWallet, privyError])

  // Privy-based wallet functions
  const connect = async () => {
    if (login) {
      await login({
        loginMethods: ['wallet'],
        walletChainType: 'solana-only',
        disableSignup: false
      })
    }
  }

  const disconnect = async () => {
    if (logout) {
      await logout()
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

  return (
    <WalletContext.Provider value={contextValue}>
      {children}
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