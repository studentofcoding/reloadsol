'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Script from 'next/script'
import JupiterTerminal from '@/components/JupiterTerminal'
import RhGmgnSwapPanel from '@/components/RhGmgnSwapPanel'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useJupiterDomSweep } from '@/hooks/useJupiterDomSweep'
import { TOKENS } from '@/utils/solana'

type SwapPreset = {
  key: string
  label: string
  inputMint: string
  outputMint: string
}

export default function SwapPageClient() {
  const { network } = useAppNetwork()
  const searchParams = useSearchParams()
  const requestedTokenMint = searchParams.get('tokenMint')?.trim() ?? ''
  const requestedFromMint = searchParams.get('fromMint')?.trim() ?? ''
  const requestedToMint = searchParams.get('toMint')?.trim() ?? ''
  const tokenMint =
    requestedTokenMint &&
    requestedTokenMint !== TOKENS.SOL &&
    requestedTokenMint !== TOKENS.USDC
      ? requestedTokenMint
      : null
  const fromMint =
    requestedFromMint &&
    requestedFromMint !== TOKENS.SOL &&
    requestedFromMint !== TOKENS.USDC
      ? requestedFromMint
      : null
  const toMint =
    requestedToMint &&
    requestedToMint !== TOKENS.SOL &&
    requestedToMint !== TOKENS.USDC
      ? requestedToMint
      : null

  const swapPresets = useMemo<SwapPreset[]>(() => {
    if (fromMint && toMint) {
      return [
        {
          key: 'token-to-token',
          label: 'Token -> Token',
          inputMint: fromMint,
          outputMint: toMint,
        },
      ]
    }
    if (tokenMint) {
      return [
        {
          key: 'sol-to-token',
          label: 'SOL -> Token',
          inputMint: TOKENS.SOL,
          outputMint: tokenMint,
        },
        {
          key: 'usdc-to-token',
          label: 'USDC -> Token',
          inputMint: TOKENS.USDC,
          outputMint: tokenMint,
        },
        {
          key: 'token-to-sol',
          label: 'Token -> SOL',
          inputMint: tokenMint,
          outputMint: TOKENS.SOL,
        },
        {
          key: 'token-to-usdc',
          label: 'Token -> USDC',
          inputMint: tokenMint,
          outputMint: TOKENS.USDC,
        },
      ]
    }
    return [
      {
        key: 'sol-to-usdc',
        label: 'SOL -> USDC',
        inputMint: TOKENS.SOL,
        outputMint: TOKENS.USDC,
      },
      {
        key: 'usdc-to-sol',
        label: 'USDC -> SOL',
        inputMint: TOKENS.USDC,
        outputMint: TOKENS.SOL,
      },
    ]
  }, [tokenMint, fromMint, toMint])
  const [selectedPresetKey, setSelectedPresetKey] = useState<string | null>(null)
  const activePreset =
    swapPresets.find((preset) => preset.key === selectedPresetKey) ??
    swapPresets[0]
  const [isPageReady, setIsPageReady] = useState(false)

  // Ensure page is ready before rendering Jupiter Terminal
  useEffect(() => {
    // Small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      setIsPageReady(true)
    }, 100)

    return () => clearTimeout(timer)
  }, [])
  
  // Idle DOM sweep for stray Jupiter overlays/branding. Interval-based and
  // idempotent (no MutationObserver), so cleanup can never re-trigger itself.
  useJupiterDomSweep({
    containerId: 'jupiter-terminal-swap',
    enabled: isPageReady,
  });

  if (network === 'robinhood') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 py-8"
        style={{ minHeight: '550px' }}
      >
        <RhGmgnSwapPanel initialToken={requestedTokenMint} />
      </div>
    )
  }

  return (
    <div
      className="flex flex-col items-center justify-center gap-4"
      style={{ minHeight: '550px' }}
    >
      <div className="flex w-full max-w-2xl flex-wrap justify-center gap-2">
        {swapPresets.map((preset) => {
          const isActive = preset.key === activePreset.key

          return (
            <button
              key={preset.key}
              type="button"
              onClick={() => setSelectedPresetKey(preset.key)}
              className={`rounded-full border px-4 py-2 text-sm transition ${
                isActive
                  ? 'border-white bg-white text-black'
                  : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500 hover:text-white'
              }`}
            >
              {preset.label}
            </button>
          )
        })}
      </div>
      <Script
        src="https://plugin.jup.ag/plugin-v1.js"
        strategy="afterInteractive"
        data-preload
      />
      {isPageReady && (
        <JupiterTerminal
          key={`${activePreset.inputMint}-${activePreset.outputMint}`}
          initialInputMint={activePreset.inputMint}
          initialOutputMint={activePreset.outputMint}
        />
      )}
    </div>
  )
}
