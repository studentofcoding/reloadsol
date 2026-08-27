'use client'

import { NetworkPreface } from '../../_components/ChainRedirect'
import SolSwapClient from '../SolSwapClient'

export default function SwapSolanaClient() {
  return (
    <NetworkPreface network="sol">
      <SolSwapClient />
    </NetworkPreface>
  )
}
