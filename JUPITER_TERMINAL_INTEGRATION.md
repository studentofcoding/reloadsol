# Jupiter Terminal Integration Guide

This guide explains how to integrate Jupiter Terminal with your existing Phantom wallet provider using `passthroughWalletContextState`.

## Overview

The integration allows Jupiter Terminal to automatically connect and sync with your existing wallet state, providing a seamless trading experience without requiring users to connect their wallet separately to Jupiter Terminal.

## Changes Made

### 1. Updated WalletProvider (`src/components/WalletProvider.tsx`)

The `WalletContextType` interface has been extended to be compatible with Jupiter Terminal:

```typescript
interface WalletContextType {
  publicKey: PublicKey | null
  connected: boolean
  connecting: boolean
  disconnecting: boolean        // Added for Jupiter Terminal
  wallet: any | null           // Added for Jupiter Terminal
  signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>
  signMessage?: (message: Uint8Array) => Promise<{ signature: Uint8Array }>
  sendTransaction?: (transaction: Transaction | VersionedTransaction, connection: SolanaConnection, options?: any) => Promise<string>  // Added for Jupiter Terminal
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}
```

**Key additions:**
- `disconnecting`: Boolean state for disconnect process
- `wallet`: Wallet adapter object that Jupiter Terminal expects
- `sendTransaction`: Method for sending transactions through the connection

### 2. Jupiter Terminal Component (`src/components/JupiterTerminal.tsx`)

A React component that:
- Initializes Jupiter Terminal with integrated display mode
- Syncs wallet state using `passthroughWalletContextState`
- Uses the same simple pattern as the existing TerminalComponent.tsx

### 3. Existing Implementation

The project already includes:
- `src/components/TerminalComponent.tsx` - Simple Jupiter Terminal component
- `src/app/(trade)/swap/SwapPageClient.tsx` - Swap page using the terminal
- `src/types/terminal.d.ts` - TypeScript declarations for window.Jupiter

## Installation

**No npm installation required!** <mcreference link="https://www.npmjs.com/package/@jup-ag/terminal" index="1">1</mcreference> Jupiter Terminal is loaded via CDN and accessed through `window.Jupiter`. The integration automatically loads the script from `https://terminal.jup.ag/main-v4.js`.

**Why CDN instead of npm?** <mcreference link="https://www.npmjs.com/package/@jup-ag/terminal" index="1">1</mcreference> Jupiter Terminal is not published on npm and is only importable via CDN to ensure you always get the latest version with all features and security updates.

## Usage

### Basic Integration

```tsx
import { useWallet } from '@/components/WalletProvider'
import JupiterTerminal from '@/components/JupiterTerminal'

function TradingPage() {
  const { connected } = useWallet()

  return (
    <div>
      {connected ? (
        <JupiterTerminal />
      ) : (
        <p>Please connect your wallet to start trading</p>
      )}
    </div>
  )
}
```

### Advanced Integration with Custom Configuration

```tsx
import { useEffect } from 'react'
import { useWallet } from '@/components/WalletProvider'

function CustomJupiterIntegration() {
  const walletContextState = useWallet()

  // Initialize Jupiter Terminal with custom configuration
  useEffect(() => {
    if (typeof window !== "undefined" && window.Jupiter && window.Jupiter.init) {
      window.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "my-terminal",
        containerClassName: "bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-6 w-full max-w-2xl mx-auto",
        enableWalletPassthrough: true,
        platformFeeAndAccounts: {
          feeBps: 50, // 0.5% platform fee
          feeAccounts: {
            SOL: 'YourFeeAccountPublicKey',
            USDC: 'YourUSDCFeeAccountPublicKey'
          }
        },
        formProps: {
          initialAmount: '100',
          initialInputMint: 'So11111111111111111111111111111111111111112', // SOL
          initialOutputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        }
      })
    }
  }, [])

  // Sync wallet state when it changes
  useEffect(() => {
    if (typeof window !== "undefined" && window.Jupiter?.syncProps && walletContextState) {
      try {
        window.Jupiter.syncProps({ passthroughWalletContextState: walletContextState })
      } catch (error) {
        console.error('Failed to sync wallet state with Jupiter Terminal:', error)
      }
    }
  }, [walletContextState])

  return (
    <div className="bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-6 w-full max-w-2xl mx-auto">
      <div id="my-terminal" />
    </div>
  )
}
```

## Key Features

### Auto-Connect
The wallet provider automatically attempts to connect to Phantom wallet on page load (if previously connected), making the Jupiter Terminal immediately usable.

### State Synchronization
Wallet state changes (connect/disconnect/account changes) are automatically synchronized with Jupiter Terminal through the `passthroughWalletContextState` prop.

### Error Handling
Both components include comprehensive error handling for:
- Missing Phantom wallet
- Connection failures
- Jupiter Terminal initialization errors

## Configuration Options

### Jupiter Terminal Init Options

```typescript
window.Jupiter.init({
  displayMode: 'integrated' | 'modal' | 'widget',
  integratedTargetId: 'string', // Required for integrated mode
  endpoint: 'string', // Solana RPC endpoint
  enableWalletPassthrough: boolean, // Enable wallet passthrough
  platformFeeAndAccounts: {
    feeBps: number, // Platform fee in basis points
    feeAccounts: Record<string, string> // Fee accounts by mint
  },
  strictTokenList: boolean, // Use strict token list
  defaultExplorer: 'SolanaFM' | 'Solscan' | 'SolanaExplorer',
  formProps: {
    initialAmount: string,
    initialInputMint: string,
    initialOutputMint: string
  }
})
```

## Troubleshooting

### Common Issues

1. **"Phantom wallet not found" error:**
   - Ensure Phantom wallet extension is installed
   - Check that the wallet is unlocked

2. **Jupiter Terminal not loading:**
   - Check browser console for script loading errors
   - Verify the CDN script is accessible: `https://terminal.jup.ag/main-v4.js`
   - Ensure the target element exists in the DOM
   - Check that `window.Jupiter` is available after script loads

3. **Wallet state not syncing:**
   - Verify `passthroughWalletContextState` is being passed correctly
   - Check that wallet context includes all required properties

### Debug Mode

Add console logs to track wallet state changes:

```tsx
useEffect(() => {
  console.log('Wallet state changed:', {
    connected: walletContextState.connected,
    publicKey: walletContextState.publicKey?.toString(),
    wallet: walletContextState.wallet
  })
}, [walletContextState])
```

## Security Considerations

- The wallet provider maintains the same security model as before
- Jupiter Terminal uses the existing wallet connection and doesn't require additional permissions
- All transactions still require user approval through Phantom wallet
- Platform fees should be clearly disclosed to users

## Current Status

The Jupiter Terminal integration is **complete and working**:

1. ✅ **WalletProvider updated** - Compatible with Jupiter Terminal's `passthroughWalletContextState`
2. ✅ **TerminalComponent implemented** - Simple, working Jupiter Terminal component
3. ✅ **Swap page active** - Available at `/swap` route with full functionality
4. ✅ **TypeScript support** - Proper type declarations for `window.Jupiter`

## Next Steps

1. **Customize configuration:** Adjust Jupiter Terminal settings in `TerminalComponent.tsx`
2. **Configure platform fees:** Set up your fee accounts if you want to earn from swaps
3. **Add to other pages:** Use the existing pattern to add Jupiter Terminal elsewhere

## Support

For Jupiter Terminal specific issues, refer to:
- [Jupiter Terminal Documentation](https://docs.jup.ag/terminal)
- [Jupiter Discord](https://discord.gg/jup)

For wallet integration issues, check the existing wallet provider implementation and Phantom wallet documentation.