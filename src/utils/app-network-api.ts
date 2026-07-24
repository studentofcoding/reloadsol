import { NextRequest, NextResponse } from 'next/server'
import type { AppNetwork } from '@/utils/app-network'
import { parseDbChain } from '@/utils/app-network-db'

/** Reject when client declares a chain that does not match this API's network. */
export function rejectWrongNetwork(
  req: NextRequest,
  expected: AppNetwork,
): NextResponse | null {
  const raw =
    req.headers.get('x-app-network') ??
    new URL(req.url).searchParams.get('chain')
  if (raw == null || raw === '') return null
  const chain = parseDbChain(raw)
  if (chain === expected) return null
  return NextResponse.json(
    { success: false, error: `This API is ${expected}-only` },
    { status: 403 },
  )
}
