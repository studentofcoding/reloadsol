import { connection, NextResponse } from 'next/server'
import { getRhBatchExecutorAddress } from '@/utils/dlmm/rh-batch-executor'

/** Public, non-secret RH execution configuration for client self-healing. */
export async function GET() {
  // Resolve per request so a restarted server can expose runtime env even when
  // the surrounding trade pages were prerendered at build time.
  await connection()
  return NextResponse.json(
    { batchExecutorAddress: getRhBatchExecutorAddress() },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    },
  )
}
