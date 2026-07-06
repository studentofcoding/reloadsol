#!/usr/bin/env npx tsx
/**
 * Manual Raptor buy/sell for mcap tracker live pilot.
 *
 *   TRADING_KEYPAIR_JSON='[...]' npm run mcap:raptor-trade -- --mint=<CA> --sol=0.01 --quote-only
 *   TRADING_KEYPAIR_JSON='[...]' npm run mcap:raptor-trade -- --mint=<CA> --sol=0.01
 *   TRADING_KEYPAIR_JSON='[...]' npm run mcap:raptor-trade -- --mint=<CA> --sell-all
 */

import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

type CliArgs = {
  mint?: string
  sol: number
  slippageBps: number
  quoteOnly: boolean
  sellAll: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    sol: 0.01,
    slippageBps: 300,
    quoteOnly: false,
    sellAll: false,
  }

  for (const arg of argv) {
    if (arg === '--quote-only' || arg === '--dry-run') {
      args.quoteOnly = true
    } else if (arg === '--sell-all') {
      args.sellAll = true
    } else if (arg.startsWith('--mint=')) {
      args.mint = arg.slice('--mint='.length).trim()
    } else if (arg.startsWith('--sol=')) {
      args.sol = parseFloat(arg.slice('--sol='.length))
    } else if (arg.startsWith('--slippage-bps=')) {
      args.slippageBps = parseInt(arg.slice('--slippage-bps='.length), 10)
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run mcap:raptor-trade -- --mint=<CA> [options]

Options:
  --mint=<CA>           Token mint address (required)
  --sol=<amount>        SOL to spend on buy (default 0.01)
  --slippage-bps=<bps>  Slippage in bps (default 300)
  --quote-only          Quote only — no sign/send
  --dry-run             Alias for --quote-only
  --sell-all            Sell full token balance back to SOL
  -h, --help            Show this help
`)
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }

  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mint) {
    console.error('Missing --mint=<TOKEN_CA>')
    process.exit(1)
  }
  if (!Number.isFinite(args.sol) || args.sol <= 0) {
    console.error('Invalid --sol amount')
    process.exit(1)
  }

  const {
    executeMcapRaptorBuy,
    executeMcapRaptorSell,
    fetchTokenBalanceRaw,
    getMcapLiveWallet,
    quoteMcapRaptorBuy,
  } = await import('../src/utils/mcap-raptor-trade')

  const wallet = getMcapLiveWallet()
  console.log(`Wallet: ${wallet}`)
  console.log(`Mint:   ${args.mint}`)

  if (args.sellAll) {
    const balanceRaw = await fetchTokenBalanceRaw(wallet, args.mint)
    if (balanceRaw === '0') {
      console.log('No token balance to sell')
      return
    }
    console.log(`Selling raw balance: ${balanceRaw}`)
    if (args.quoteOnly) {
      console.log('Quote-only — skipping sell')
      return
    }
    const sell = await executeMcapRaptorSell(args.mint, balanceRaw, args.slippageBps)
    console.log(`Sell signature: ${sell.signature}`)
    console.log(`SOL received:   ${sell.solReceived}`)
    return
  }

  if (args.quoteOnly) {
    const quote = await quoteMcapRaptorBuy(args.mint, args.sol, args.slippageBps)
    console.log('Quote OK:')
    console.log(`  amountIn:  ${quote.amountIn}`)
    console.log(`  amountOut: ${quote.amountOut}`)
    console.log(`  minOut:    ${quote.minAmountOut}`)
    console.log(`  impact:    ${quote.priceImpact}`)
    return
  }

  const buy = await executeMcapRaptorBuy(args.mint, args.sol, args.slippageBps)
  console.log(`Buy signature:    ${buy.signature}`)
  console.log(`Output raw:       ${buy.outputAmountRaw}`)
  console.log(`Token amount UI:  ${buy.tokenAmountUi}`)
  console.log(`Status URL:       https://raptor-beta.solanatracker.io/transaction/${buy.signature}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
