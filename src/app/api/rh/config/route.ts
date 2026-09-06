import { NextResponse } from 'next/server'
import { getRhBatchExecutorAddress } from '@/utils/dlmm/rh-batch-executor'

/** Public, non-secret RH execution configuration for client self-healing. */
export async function GET() {
  return NextResponse.json(
    { batchExecutorAddress: getRhBatchExecutorAddress() },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    },
  )
}
