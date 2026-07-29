import { describe, expect, it } from 'vitest'
import {
  formatRhClmmManageAlert,
  rhClmmManageAlertKey,
  shouldAlertFees,
} from '@/utils/dlmm/rh-clmm-manage-alerts'

describe('rh-clmm-manage alert helpers', () => {
  it('builds lowercased throttle keys', () => {
    expect(rhClmmManageAlertKey('0xABC', '42', 'oor')).toBe(
      'rh-clmm-manage:alert:v1:0xabc:42:oor',
    )
    expect(rhClmmManageAlertKey('0xABC', '42', 'fees')).toContain(':fees')
  })

  it('fee threshold gate', () => {
    expect(shouldAlertFees(10, 5)).toBe(true)
    expect(shouldAlertFees(5, 5)).toBe(true)
    expect(shouldAlertFees(4.99, 5)).toBe(false)
    expect(shouldAlertFees(Number.NaN, 5)).toBe(false)
    expect(shouldAlertFees(10, 0)).toBe(false)
  })

  it('formats OOR and fee alerts', () => {
    const oor = formatRhClmmManageAlert({
      kind: 'oor',
      pairLabel: 'WETH/FOO',
      protocol: 'v4',
      tokenId: '42',
      owner: '0x1234567890abcdef',
      tickLower: -100,
      tickUpper: 100,
      currentTick: 250,
    })
    expect(oor).toContain('out of range')
    expect(oor).toContain('#42')
    expect(oor).toContain('250')

    const fees = formatRhClmmManageAlert({
      kind: 'fees',
      pairLabel: 'WETH/FOO',
      protocol: 'v4',
      tokenId: '42',
      owner: '0x1234567890abcdef',
      unclaimedFeesUsd: 12.5,
    })
    expect(fees).toContain('fees ready to claim')
    expect(fees).toContain('$12.50')
  })
})

describe('rh-clmm pool_key ledger (item 2)', () => {
  it('migration 25 adds pool_key columns', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sql = readFileSync(
      join(process.cwd(), 'db/init/25-rh-clmm-pool-key.sql'),
      'utf8',
    )
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS pool_id TEXT')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS pool_key JSONB')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS fee INTEGER')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS tick_spacing INTEGER')
  })

  it('rh-clmm-db persists pool_key at insert', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(process.cwd(), 'src/utils/dlmm/rh-clmm-db.ts'),
      'utf8',
    )
    expect(src).toContain('pool_id, pool_key, fee, tick_spacing')
    expect(src).toContain(
      'pool_key = COALESCE(EXCLUDED.pool_key, rh_clmm_positions.pool_key)',
    )
  })

  it('v4 mint result carries poolKey and tickSpacing', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(process.cwd(), 'src/utils/dlmm/rh-clmm/v4.ts'),
      'utf8',
    )
    expect(src).toContain('poolKey: V4PoolKey;')
    expect(src).toContain('tickSpacing: number;')
  })
})

describe('rh-clmm-manage worker wiring (item 5)', () => {
  it('route uses network gate + manage secret + job lock', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(process.cwd(), 'src/app/api/dlmm/rh-clmm-manage/route.ts'),
      'utf8',
    )
    expect(src).toContain("rejectWrongNetwork(req, 'robinhood')")
    expect(src).toContain('process.env.DLMM_MANAGE_SECRET')
    expect(src).toContain("acquireJobLock('rh_clmm_manage'")
  })

  it('Go cron registers rh_clmm_manage', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const main = readFileSync(join(process.cwd(), 'main.go'), 'utf8')
    expect(main).toContain('cs.runRhClmmManage')
    expect(main).toContain('/api/dlmm/rh-clmm-manage')
    expect(main).toContain('/trigger/rh-clmm-manage')
    const tracker = readFileSync(join(process.cwd(), 'worker_tracker.go'), 'utf8')
    expect(tracker).toContain('ID: "rh_clmm_manage"')
  })
})
