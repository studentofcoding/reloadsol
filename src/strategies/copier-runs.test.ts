import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('@/utils/db', () => ({ query: (...args: unknown[]) => query(...args) }))

async function load() {
  vi.resetModules()
  return import('./copier-runs')
}

describe('copier-runs stale reaper', () => {
  beforeEach(() => {
    query.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('reaps stale running rows once, on the first startCopierRun, excluding the new run', async () => {
    const mod = await load()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO copier_runs')) return { rows: [{ id: '77' }] }
      if (sql.includes("SET outcome = 'failed'")) return { rows: [{ id: '2' }, { id: '4' }] }
      return { rows: [] }
    })

    expect(await mod.startCopierRun('cron')).toBe('77')
    const reapCalls = query.mock.calls.filter(([sql]) => String(sql).includes("SET outcome = 'failed'"))
    expect(reapCalls).toHaveLength(1)
    const [sql, params] = reapCalls[0]
    expect(sql).toContain("outcome = 'running'")
    expect(sql).toContain('started_at < NOW()')
    expect(params).toEqual([mod.COPIER_ORPHAN_MIN_AGE_MINUTES, mod.COPIER_ORPHAN_DETAIL, '77'])

    // Second sweep in the same process does not reap again.
    await mod.startCopierRun('cron')
    expect(
      query.mock.calls.filter(([s]) => String(s).includes("SET outcome = 'failed'")),
    ).toHaveLength(1)
  })

  it('never lets a reaper failure fail the run', async () => {
    const mod = await load()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO copier_runs')) return { rows: [{ id: '5' }] }
      if (sql.includes("SET outcome = 'failed'")) throw new Error('boom')
      return { rows: [] }
    })
    expect(await mod.startCopierRun('cron')).toBe('5')
  })

  it('returns null (fail-open) when the insert fails', async () => {
    const mod = await load()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO copier_runs')) throw new Error('db down')
      return { rows: [] }
    })
    expect(await mod.startCopierRun('cron')).toBeNull()
  })
})
