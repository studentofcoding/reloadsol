#!/usr/bin/env npx tsx
/**
 * Seed tracked_wallets from data/tracked-wallets.txt
 * Usage: npx tsx scripts/seed-tracked-wallets.ts [--dry-run] [--file path/to/wallets.txt]
 */
import fs from 'fs'
import path from 'path'
import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: path.resolve(__dirname, '../.env.local') })
loadEnv({ path: path.resolve(__dirname, '../.env') })

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

type WalletSeed = {
  address: string
  label: string
  tier: 'tier1' | 'tier2'
  tags: string[]
}

function normalizeAddress(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '').trim()
  if (BASE58.test(compact)) return compact
  return null
}

function parsePotentialWalletFile(filePath: string): WalletSeed[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const byAddress = new Map<string, WalletSeed>()

  const tier1Labels = ['cupsey', 'profitier', 'ferb', 'ansem', 'beaniemaxi']

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let label = ''
    let addressRaw = ''

    const addressMatch = line.match(/^Address:\s*(.+)$/i)
    if (addressMatch) {
      addressRaw = addressMatch[1]
      const prev = lines[i - 1]?.trim() ?? ''
      const nameMatch = prev.match(/^Name:\s*(.+)$/i)
      label = nameMatch?.[1] ?? prev.replace(/^Name:\s*/i, '')
    }

    const walletNameMatch = line.match(/^Wallet Name:\s*(.+)$/i)
    if (walletNameMatch) {
      label = walletNameMatch[1].trim()
      const next = lines[i + 1]?.trim() ?? ''
      if (/^Wallet Address:/i.test(next)) {
        addressRaw = lines[i + 2]?.trim() ?? ''
        i += 2
      } else if (/^• Wallet Address:/i.test(next)) {
        addressRaw = lines[i + 2]?.trim() ?? ''
        i += 2
      }
    }

    if (!addressRaw) continue
    const address = normalizeAddress(addressRaw)
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
