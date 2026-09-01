import { NextRequest, NextResponse, connection } from 'next/server'
import {
  deleteTrackedWallet,
  fetchSocialIngestStats,
  fetchSocialRollups,
  listTrackedWallets,
  upsertTrackedWallet,
} from '@/strategies/social/db'
import { normalizeSolanaAddress } from '@/utils/solana-address'


export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  await connection()
  const rollupsLimit = Number(request.nextUrl.searchParams.get('rollups_limit') ?? 50)
  const [wallets, rollups, stats] = await Promise.all([
    listTrackedWallets(false),
    fetchSocialRollups(rollupsLimit),
    fetchSocialIngestStats(),
  ])

  return NextResponse.json({
    success: true,
    wallets,
    rollups,
    stats,
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      address?: string
      label?: string
      tier?: 'tier1' | 'tier2'
      tags?: string[]
      is_active?: boolean
    }

    if (!body.address || !body.label) {
      return NextResponse.json(
        { success: false, error: 'address and label required' },
        { status: 400 },
      )
    }

    const address = normalizeSolanaAddress(body.address)
    if (!address) {
      return NextResponse.json(
        { success: false, error: 'Invalid Solana wallet address' },
        { status: 400 },
      )
    }

    const ok = await upsertTrackedWallet({
      address,
      label: body.label.trim(),
      tier: body.tier === 'tier1' ? 'tier1' : 'tier2',
      tags: Array.isArray(body.tags) ? body.tags : [],
      is_active: body.is_active !== false,
    })

    return NextResponse.json({ success: ok })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address')
  if (!address) {
    return NextResponse.json({ success: false, error: 'address required' }, { status: 400 })
  }

  const ok = await deleteTrackedWallet(address)
  return NextResponse.json({ success: ok })
}
