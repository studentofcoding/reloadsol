import {
  fetchShyftAllTokensDirect,
  SOL_MINT,
} from '@/utils/shyft-wallet'
import {
  insertSocialEvents,
  listTrackedWallets,
  markWalletPolled,
  upsertWalletHolding,
} from '@/strategies/social/db'
import { isValidSolanaAddress } from '@/utils/solana-address'

const STABLE_MINTS = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
])

export async function pollTrackedWallets(): Promise<{
  walletsPolled: number
  newBuys: number
  errors: string[]
}> {
  const wallets = await listTrackedWallets(true)
  let newBuys = 0
  const errors: string[] = []

  for (const wallet of wallets) {
    if (!isValidSolanaAddress(wallet.address)) {
      const message = 'Invalid Solana address'
      errors.push(`${wallet.address}: ${message}`)
      await markWalletPolled(wallet.address, message)
      continue
    }

    try {
      const { tokens } = await fetchShyftAllTokensDirect(wallet.address)
      const seenAt = new Date().toISOString()

      for (const token of tokens) {
        if (STABLE_MINTS.has(token.address)) continue
        if (!token.balance || token.balance <= 0) continue

        const status = await upsertWalletHolding(wallet.address, token.address, seenAt)
        if (status !== 'inserted') continue

        await insertSocialEvents([
          {
            token_address: token.address,
            event_type: 'wallet_buy',
            source: 'tracked_wallet_poll',
            wallet_address: wallet.address,
            wallet_label: wallet.label,
            external_message_id: `${wallet.address}:${token.address}:${seenAt}`,
            occurred_at: seenAt,
            raw_metadata: {
              from_tracked_wallet: true,
              tier: wallet.tier,
              tags: wallet.tags,
              token_symbol: token.info?.symbol ?? null,
              ui_balance: token.balance,
            },
          },
        ])
        newBuys += 1
        console.info('[social/wallet-poll] new holding', {
          wallet: wallet.label,
          token: token.address,
        })
      }

      await markWalletPolled(wallet.address, null)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      errors.push(`${wallet.address}: ${message}`)
      await markWalletPolled(wallet.address, message)
    }
  }

  return {
    walletsPolled: wallets.length,
    newBuys,
    errors,
  }
}
