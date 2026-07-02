import { NextResponse } from 'next/server'
import { isDbCircuitOpen, isDbConfigured } from '@/utils/db-health'
import { queryOne } from '@/utils/db'

export async function HEAD() {
  return new NextResponse(null, { status: 200 })
}

export async function GET() {
  try {
    const circuitOpen = isDbCircuitOpen()
    let db: { ok: boolean; error?: string; circuitOpen: boolean } = {
      ok: false,
      circuitOpen,
    }
    if (isDbConfigured()) {
      try {
        await queryOne('SELECT 1 AS ok', [], { bypassCircuit: true })
        db = { ok: true, circuitOpen: isDbCircuitOpen() }
      } catch (error) {
        db = {
          ok: false,
          circuitOpen: isDbCircuitOpen(),
          error: error instanceof Error ? error.message : 'Database ping failed',
        }
      }
    } else {
      db = { ok: false, circuitOpen, error: 'DATABASE_URL not configured' }
    }

    return NextResponse.json({
      status: db.ok ? 'healthy' : 'degraded',
      db,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '1.0.0',
    })
  } catch (error) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}