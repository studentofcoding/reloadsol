import { NextRequest, NextResponse } from 'next/server'
import type { DlmmPotentialSource } from '@/types/dlmm'
import {
  getPotentialList,
  markTokenPotential,
  toggleTokenPotential,
  unmarkTokenPotential,
} from '@/utils/potential-list/service'

const VALID_SOURCES: DlmmPotentialSource[] = [
  'signals',
  'live',
  'board',
  'tracker',
  'algo-dashboard',
  'algo-history',
  'dlmm-general',
]

export async function GET() {
  try {
    const entries = await getPotentialList()
    return NextResponse.json({ success: true, entries })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load potential list',
      },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const tokenAddress = String(
      body.tokenAddress ?? body.token_address ?? '',
    ).trim()
    const tokenSymbol = body.tokenSymbol ?? body.token_symbol ?? null
    const source = (body.source ?? 'signals') as DlmmPotentialSource
    const notes = body.notes ?? null
    const action = body.action as 'mark' | 'unmark' | 'toggle' | undefined

    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress is required' },
        { status: 400 },
      )
    }

    if (action === 'unmark') {
      await unmarkTokenPotential(tokenAddress)
      return NextResponse.json({ success: true, potential: false })
    }

    if (!VALID_SOURCES.includes(source)) {
      return NextResponse.json(
        { success: false, error: 'Invalid source' },
        { status: 400 },
      )
    }

    if (action === 'toggle') {
      const potential = await toggleTokenPotential({
        tokenAddress,
        tokenSymbol: tokenSymbol ? String(tokenSymbol) : null,
        source,
        notes: notes ? String(notes) : null,
      })
      return NextResponse.json({ success: true, potential })
    }

    const entry = await markTokenPotential({
      tokenAddress,
      tokenSymbol: tokenSymbol ? String(tokenSymbol) : null,
      source,
      notes: notes ? String(notes) : null,
    })

    return NextResponse.json({ success: true, entry, potential: true })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update potential list',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const tokenAddress = req.nextUrl.searchParams.get('tokenAddress')?.trim()
    if (!tokenAddress) {
      return NextResponse.json(
        { success: false, error: 'tokenAddress query param is required' },
        { status: 400 },
      )
    }

    await unmarkTokenPotential(tokenAddress)
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to remove from potential list',
      },
      { status: 500 },
    )
  }
}
