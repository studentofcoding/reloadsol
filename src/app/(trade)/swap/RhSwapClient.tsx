'use client'

import { useSearchParams } from 'next/navigation'
import RhGmgnSwapPanel from '@/components/RhGmgnSwapPanel'

export default function RhSwapClient() {
  const searchParams = useSearchParams()
  const requestedTokenMint = searchParams.get('tokenMint')?.trim() ?? ''
  const requestedFromToken = searchParams.get('fromToken')?.trim() ?? ''
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 py-8"
      style={{ minHeight: '550px' }}
    >
      <RhGmgnSwapPanel
        initialToken={requestedTokenMint}
        initialFromToken={requestedFromToken}
      />
    </div>
  )
}
