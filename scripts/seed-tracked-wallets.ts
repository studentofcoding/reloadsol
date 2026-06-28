#!/usr/bin/env npx tsx
/**
 * Seed tracked_wallets from data/tracked-wallets.txt
 * Usage: npx tsx scripts/seed-tracked-wallets.ts [--dry-run] [--file path/to/wallets.txt]
 */
import fs from 'fs'
import path from 'path'
import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { isValidSolanaAddress, normalizeSolanaAddress } from '../src/utils/solana-address'

loadEnv({ path: path.resolve(__dirname, '../.env.local') })
loadEnv({ path: path.resolve(__dirname, '../.env') })

type WalletSeed = {
  address: string
  label: string
  tier: 'tier1' | 'tier2'
  tags: string[]
}

function isAddressHeader(line: string): boolean {
  return /^Address:\s*/i.test(line) || /^•?\s*Wallet Address:/i.test(line)
}

function isRecordStart(line: string): boolean {
  return (
    /^Wallet Name:/i.test(line) ||
    /^• Wallet Name:/i.test(line) ||
    /^Name:/i.test(line) ||
    isAddressHeader(line)
  )
}

/** Join lines after an address header until a valid Solana pubkey or record boundary. */
function collectAddressFromLines(
  lines: string[],
  startIndex: number,
  inlineValue?: string,
): { address: string | null; nextIndex: number } {
  let compact = (inlineValue ?? '').replace(/\s+/g, '')

  if (compact && isValidSolanaAddress(compact)) {
    return { address: normalizeSolanaAddress(compact), nextIndex: startIndex }
  }

  let i = inlineValue ? startIndex : startIndex + 1
  while (i < lines.length) {
    const raw = lines[i].trim()
    if (!raw) break
    if (isRecordStart(raw)) break

    compact += raw.replace(/\s+/g, '')
    if (isValidSolanaAddress(compact)) {
      return { address: normalizeSolanaAddress(compact), nextIndex: i }
    }
    i += 1
  }

  return { address: null, nextIndex: i - 1 }
}

function parsePotentialWalletFile(filePath: string): WalletSeed[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const byAddress = new Map<string, WalletSeed>()

  const tier1Labels = ['cupsey', 'profitier', 'ferb', 'ansem', 'beaniemaxi']

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let label = ''
    let address: string | null = null

    const addressMatch = line.match(/^Address:\s*(.*)$/i)
    if (addressMatch) {
      const prev = lines[i - 1]?.trim() ?? ''
      const nameMatch = prev.match(/^Name:\s*(.+)$/i)
      label = nameMatch?.[1] ?? prev.replace(/^Name:\s*/i, '')
      const collected = collectAddressFromLines(lines, i, addressMatch[1])
      address = collected.address
      i = collected.nextIndex
    }

    const walletNameMatch = line.match(/^•?\s*Wallet Name:\s*(.+)$/i)
    if (walletNameMatch && !address) {
      label = walletNameMatch[1].trim()
      const next = lines[i + 1]?.trim() ?? ''
      if (isAddressHeader(next)) {
        const inline = next.replace(/^•?\s*Wallet Address:\s*/i, '').replace(/^Address:\s*/i, '')
        const collected = collectAddressFromLines(lines, i + 1, inline || undefined)
        address = collected.address
        i = collected.nextIndex
      }
    }

    if (!address) continue

    const lower = label.toLowerCase()
    const tier = tier1Labels.some((t) => lower.includes(t)) ? 'tier1' : 'tier2'
    const tags: string[] = []
    if (lower.includes('profitier')) tags.push('Profitier')
    if (lower.includes('smart')) tags.push('SmartTrader')
    if (lower.includes('ferb')) tags.push('ferb')

    if (!byAddress.has(address)) {
      byAddress.set(address, {
        address,
        label: label || address.slice(0, 8),
        tier,
        tags,
      })
    }
  }

  return Array.from(byAddress.values())
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const root = path.resolve(__dirname, '..')
  const fileArgIdx = process.argv.indexOf('--file')
  const filePath =
    fileArgIdx >= 0 && process.argv[fileArgIdx + 1]
      ? path.resolve(process.argv[fileArgIdx + 1])
      : path.join(root, 'data', 'tracked-wallets.txt')

  if (!fs.existsSync(filePath)) {
    console.error('Missing', filePath)
    process.exit(1)
  }

  const wallets = parsePotentialWalletFile(filePath)
  console.log(`Parsed ${wallets.length} unique wallet addresses`)

  if (dryRun) {
    console.log(wallets.slice(0, 5))
    return
  }

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY?.trim()
  if (!url || !key) {
    console.error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY')
    process.exit(1)
  }

  const supabase = createClient(url, key)
  const { error } = await supabase.from('tracked_wallets').upsert(
    wallets.map((w) => ({
      address: w.address,
      label: w.label,
      tier: w.tier,
      tags: w.tags,
      is_active: true,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: 'address' },
  )

  if (error) {
    console.error('Upsert failed:', error.message)
    process.exit(1)
  }

  console.log(`Seeded ${wallets.length} tracked_wallets`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
