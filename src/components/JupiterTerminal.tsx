'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useWallet } from './WalletProvider'
import { useTradingData } from './TradingDataProvider'
import { getSolPriceUSD } from '@/utils/solana'

interface JupiterTerminalProps {
  initialInputMint?: string
  initialOutputMint?: string
}

// Jupiter Terminal callback types based on documentation
interface SwapResult {
  txid: string
  inputAddress: string
  outputAddress: string
  inputAmount: number
  outputAmount: number
  inputSymbol?: string
  outputSymbol?: string
  inputName?: string
  outputName?: string
  inputLogoURI?: string
  outputLogoURI?: string
  inputDecimals?: number
  outputDecimals?: number
  slippageBps?: number
  feeAmount?: number
}

interface QuoteResponseMeta {
  quoteResponse?: any
  swapMode?: string
}

interface SwapSuccessData {
  txid: string
  swapResult: SwapResult
  quoteResponseMeta?: QuoteResponseMeta
}

interface SwapErrorData {
  error: any
  quoteResponseMeta?: QuoteResponseMeta
}

export default function JupiterTerminal({ 
  initialInputMint = 'So11111111111111111111111111111111111111112', // SOL
  initialOutputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
}: JupiterTerminalProps) {
  const walletContextState = useWallet()
  const { trackOperation } = useTradingData()
  const terminalRef = useRef<HTMLDivElement>(null)

  // Handle successful swap
  const handleSwapSuccess = useCallback(async ({ txid, swapResult, quoteResponseMeta }: SwapSuccessData) => {
    try {
      console.log('🎉 Jupiter swap successful:', { txid, swapResult, quoteResponseMeta })
      
      if (!walletContextState.publicKey) {
        console.warn('No wallet connected, skipping swap tracking')
        return
      }

      const walletAddress = walletContextState.publicKey.toString()
      
      // Get current SOL price for accurate tracking
      const solPriceUsd = await getSolPriceUSD()
      
      // Determine operation type based on input/output tokens
      const SOL_MINT = 'So11111111111111111111111111111111111111112'
      const isInputSol = swapResult.inputAddress === SOL_MINT
      const isOutputSol = swapResult.outputAddress === SOL_MINT
      
      let operationType: 'buy' | 'sell'
      let tokenInfo: any
      let solAmount: number
      let tokenAmount: number
      
      if (isInputSol && !isOutputSol) {
        // SOL -> Token = Buy
        operationType = 'buy'
        solAmount = swapResult.inputAmount / Math.pow(10, swapResult.inputDecimals || 9) // Convert from lamports
        tokenAmount = swapResult.outputAmount / Math.pow(10, swapResult.outputDecimals || 6)
        tokenInfo = {
          mintAddress: swapResult.outputAddress,
          symbol: swapResult.outputSymbol,
          name: swapResult.outputName,
          logoURI: swapResult.outputLogoURI,
          tokenAmount,
          solAmount,
          priceUsd: tokenAmount > 0 ? (solAmount * solPriceUsd) / tokenAmount : 0,
          solPrice: solPriceUsd
        }
      } else if (!isInputSol && isOutputSol) {
        // Token -> SOL = Sell
        operationType = 'sell'
        solAmount = swapResult.outputAmount / Math.pow(10, swapResult.outputDecimals || 9) // Convert from lamports
        tokenAmount = swapResult.inputAmount / Math.pow(10, swapResult.inputDecimals || 6)
        tokenInfo = {
          mintAddress: swapResult.inputAddress,
          symbol: swapResult.inputSymbol,
          name: swapResult.inputName,
          logoURI: swapResult.inputLogoURI,
          tokenAmount,
          solAmount,
          priceUsd: tokenAmount > 0 ? (solAmount * solPriceUsd) / tokenAmount : 0,
          solPrice: solPriceUsd
        }
      } else {
        // Token -> Token swap, treat as sell of input token and buy of output token
        console.log('Token-to-token swap detected, tracking as sell + buy')
        
        // Track as sell of input token
        const inputSolValue = (swapResult.inputAmount / Math.pow(10, swapResult.inputDecimals || 6)) * 
                             (quoteResponseMeta?.quoteResponse?.inputTokenPrice || 0) / solPriceUsd
        
        await trackOperation({
          walletAddress,
          operationType: 'sell',
          tokens: [{
            mintAddress: swapResult.inputAddress,
            symbol: swapResult.inputSymbol,
            name: swapResult.inputName,
            logoURI: swapResult.inputLogoURI,
            tokenAmount: swapResult.inputAmount / Math.pow(10, swapResult.inputDecimals || 6),
            solAmount: inputSolValue,
            priceUsd: quoteResponseMeta?.quoteResponse?.inputTokenPrice || 0,
            solPrice: solPriceUsd
          }],
          successCount: 1,
          failureCount: 0,
          totalTokens: 1,
          solAmount: inputSolValue,
          feesPaid: (swapResult.feeAmount || 0) / Math.pow(10, 9), // Convert fee from lamports
          solPriceUsd,
          totalUsdValue: inputSolValue * solPriceUsd,
          signatures: [txid],
          slippage: swapResult.slippageBps ? swapResult.slippageBps / 100 : undefined,
          is_bot_operation: false // Jupiter Terminal swaps are manual
        })
        
        // Track as buy of output token
        const outputSolValue = (swapResult.outputAmount / Math.pow(10, swapResult.outputDecimals || 6)) * 
                              (quoteResponseMeta?.quoteResponse?.outputTokenPrice || 0) / solPriceUsd
        
        operationType = 'buy'
        solAmount = outputSolValue
        tokenAmount = swapResult.outputAmount / Math.pow(10, swapResult.outputDecimals || 6)
        tokenInfo = {
          mintAddress: swapResult.outputAddress,
          symbol: swapResult.outputSymbol,
          name: swapResult.outputName,
          logoURI: swapResult.outputLogoURI,
          tokenAmount,
          solAmount,
          priceUsd: quoteResponseMeta?.quoteResponse?.outputTokenPrice || 0,
          solPrice: solPriceUsd
        }
      }
      
      // Track the operation
      await trackOperation({
        walletAddress,
        operationType,
        tokens: [tokenInfo],
        successCount: 1,
        failureCount: 0,
        totalTokens: 1,
        solAmount,
        feesPaid: (swapResult.feeAmount || 0) / Math.pow(10, 9), // Convert fee from lamports
        solPriceUsd,
        totalUsdValue: solAmount * solPriceUsd,
        signatures: [txid],
        slippage: swapResult.slippageBps ? swapResult.slippageBps / 100 : undefined,
        is_bot_operation: false // Jupiter Terminal swaps are manual
      })
      
      console.log(`✅ Successfully tracked Jupiter ${operationType} operation:`, {
        token: tokenInfo.symbol || tokenInfo.name || 'Unknown',
        amount: tokenAmount,
        solAmount,
        txid
      })
      
    } catch (error) {
      console.error('❌ Failed to track Jupiter swap:', error)
    }
  }, [walletContextState.publicKey, trackOperation])

  // Handle swap error
  const handleSwapError = useCallback(({ error, quoteResponseMeta }: SwapErrorData) => {
    console.error('❌ Jupiter swap failed:', { error, quoteResponseMeta })
    
    // Could track failed swaps here if needed
    // For now, just log the error
  }, [])

  // Initialize Jupiter Terminal
  useEffect(() => {
    if (typeof window !== "undefined" && window.Jupiter && window.Jupiter.init) {
      console.log('Initializing Jupiter Terminal with swap tracking:', {
        initialInputMint,
        initialOutputMint,
        displayMode: "integrated"
      })
      
      window.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "jupiter-terminal-swap",
        containerClassName: "rounded-2xl p-6 w-full max-w-2xl mx-auto",
        containerStyles: {
          height: "500px",
          paddingTop: "50px"
        },
        enableWalletPassthrough: true,
        initialInputMint,
        initialOutputMint,
        // Add swap tracking callbacks
        onSuccess: handleSwapSuccess,
        onSwapError: handleSwapError,
      })
    }
  }, [initialInputMint, initialOutputMint, handleSwapSuccess, handleSwapError])

  // Sync wallet state with Jupiter Terminal
  useEffect(() => {
    if (typeof window !== "undefined" && window.Jupiter?.syncProps && walletContextState) {
      try {
        console.log('Syncing wallet state with Jupiter Terminal:', {
          connected: walletContextState.connected,
          publicKey: walletContextState.publicKey?.toString(),
          wallet: walletContextState.wallet
        })
        window.Jupiter.syncProps({ 
          passthroughWalletContextState: walletContextState 
        })
      } catch (error) {
        console.error('Failed to sync wallet state with Jupiter Terminal:', error)
      }
    } else {
      console.log('Jupiter Terminal sync conditions not met:', {
        hasWindow: typeof window !== "undefined",
        hasJupiter: !!window.Jupiter,
        hasSyncProps: !!window.Jupiter?.syncProps,
        hasWalletState: !!walletContextState
      })
    }
  }, [walletContextState])

  return (
    <div className="mx-auto border-none">
      <div id="jupiter-terminal-swap" ref={terminalRef} />
    </div>
  )
}