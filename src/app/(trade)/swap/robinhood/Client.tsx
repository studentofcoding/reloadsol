'use client'

import { NetworkPreface } from '../../_components/ChainRedirect'
import RhSwapClient from '../RhSwapClient'

export default function SwapRobinhoodClient() {
  return (
    <NetworkPreface network="robinhood">
      <RhSwapClient />
    </NetworkPreface>
  )
}
