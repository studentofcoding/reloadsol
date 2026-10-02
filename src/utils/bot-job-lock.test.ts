import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('@/utils/db', () => ({ query: queryMock }))
vi.mock('@/utils/db-health', () => ({
  isDbCircuitOpen: () => false,
  isDbQuotaOrTimeoutError: () => false,
  formatDbConnectionError: (error: unknown) => String(error),
}))

import {
  INSTANCE_ID,
  isOrphanedLock,
  parseLockOwner,
  renewJobLock,
  startJobLockHeartbeat,
} from './bot-job-lock'

const HOST = 'web-1'
const alive = () => true
const dead = () => false

describe('INSTANCE_ID', () => {
  it('identifies host, pid and boot epoch so a row can be traced back to a process', () => {
    const owner = parseLockOwner(INSTANCE_ID)
    expect(owner).not.toBeNull()
    expect(owner?.pid).toBe(process.pid)
    expect(owner?.bootedAt).toBeGreaterThan(0)
    expect(owner?.bootedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('parseLockOwner', () => {
  it('parses a well-formed owner', () => {
    expect(parseLockOwner('web-1:42:1700000000000')).toEqual({
      host: 'web-1',
      pid: 42,
      bootedAt: 1_700_000_000_000,
    })
  })

  it('refuses the legacy random-uuid owner, so those rows are never swept', () => {
    // Before this change `locked_by` was `worker-<uuid>`: unparseable, and therefore untouchable
    // by the sweep. It waits out the TTL exactly as it did before.
    expect(parseLockOwner('worker-99503880-a773-46ff-92c2-73163feea6da')).toBeNull()
    expect(parseLockOwner('')).toBeNull()
    expect(parseLockOwner(null)).toBeNull()
    expect(parseLockOwner(undefined)).toBeNull()
  })

  it('refuses malformed pids and epochs', () => {
    expect(parseLockOwner('web-1:notapid:1700000000000')).toBeNull()
    expect(parseLockOwner('web-1:0:1700000000000')).toBeNull()
    expect(parseLockOwner('web-1:-3:1700000000000')).toBeNull()
    expect(parseLockOwner('web-1:4.5:1700000000000')).toBeNull()
    expect(parseLockOwner('web-1:42:')).toBeNull()
    expect(parseLockOwner(':42:1700000000000')).toBeNull()
  })
})

/**
 * The TTL is the only backstop that works across hosts (a recreate gets a new hostname, so the
 * previous container's lock is a foreign owner the orphan sweep must not touch). Renewal is what
 * lets that backstop be short enough to be cheap instead of costing a whole extra sweep.
 */
describe('renewJobLock', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('extends only a lock this instance still owns', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 })
    await expect(renewJobLock('metrics_copier', 180)).resolves.toBe(true)

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('UPDATE bot_job_locks')
    // The guarded update is the safety property: a stale process can never extend a lock a live one
    // has taken over.
    expect(sql).toContain('locked_by = $3')
    expect(params[1]).toBe('metrics_copier')
    expect(params[2]).toBe(INSTANCE_ID)
    const ttlMs = Date.parse(String(params[0])) - Date.now()
    expect(ttlMs).toBeGreaterThan(170_000)
    expect(ttlMs).toBeLessThanOrEqual(181_000)
  })

  it('reports false when the row is gone, rather than pretending it still holds it', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    await expect(renewJobLock('metrics_copier', 180)).resolves.toBe(false)
  })

  it('never throws — a failed renewal must not fail the work the lock protects', async () => {
    queryMock.mockRejectedValue(new Error('connection terminated'))
    await expect(renewJobLock('metrics_copier', 180)).resolves.toBe(false)
  })
})

describe('startJobLockHeartbeat', () => {
  it('renews on the interval, and stops when cleared', async () => {
    vi.useFakeTimers()
    try {
      queryMock.mockReset()
      queryMock.mockResolvedValue({ rows: [], rowCount: 1 })
      const timer = startJobLockHeartbeat('metrics_copier', 180, 60)

      expect(queryMock).not.toHaveBeenCalled() // not at creation: the acquire already set the TTL
      await vi.advanceTimersByTimeAsync(60_000)
      expect(queryMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(queryMock).toHaveBeenCalledTimes(3)

      clearInterval(timer)
      await vi.advanceTimersByTimeAsync(180_000)
      expect(queryMock).toHaveBeenCalledTimes(3) // a cleared heartbeat cannot outlive the sweep
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isOrphanedLock', () => {
  const opts = { host: HOST, selfPid: 999, selfBootedAt: 5_000, isPidAlive: dead }

  it('is orphaned when a same-host owner pid is gone — the deploy/crash case', () => {
    expect(isOrphanedLock(`${HOST}:4242:1000`, opts)).toBe(true)
  })

  it('is NOT orphaned while the owner is still running', () => {
    expect(isOrphanedLock(`${HOST}:4242:1000`, { ...opts, isPidAlive: alive })).toBe(false)
  })

  it('treats a recycled pid as orphaned: same pid, different boot epoch', () => {
    // Our own pid, but the row was written by an earlier process that had it.
    expect(isOrphanedLock(`${HOST}:999:1`, { ...opts, isPidAlive: alive })).toBe(true)
  })

  it('never touches another host: a pid means nothing there', () => {
    expect(isOrphanedLock('web-2:4242:1000', opts)).toBe(false)
    expect(isOrphanedLock(INSTANCE_ID, { ...opts, host: 'somewhere-else' })).toBe(false)
  })

  it('leaves legacy and unparseable owners alone', () => {
    expect(isOrphanedLock('worker-99503880-a773-46ff-92c2-73163feea6da', opts)).toBe(false)
    expect(isOrphanedLock(null, opts)).toBe(false)
  })

  it('does not consider this same process epoch an orphan', () => {
    expect(
      isOrphanedLock(`${HOST}:999:5000`, { ...opts, isPidAlive: alive }),
    ).toBe(false)
  })
})
