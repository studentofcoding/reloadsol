import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTE = resolve(HERE, '../route.ts')

const src = readFileSync(ROUTE, 'utf8')

/**
 * A source-level guard, because the behaviour it protects cannot be unit-tested: whether a long pass
 * yields is a property of a 120s TTL against a 60s tick, and it only shows up in production as
 * "previous run still in progress", tick after tick, for half an hour.
 *
 * The history is worth keeping. 2e96be7 ADDED a heartbeat here, correctly at the time: the TTL
 * equalled the Go client's per-pass timeout, so a pass outliving its timeout lost its lock and the
 * next tick started a second pass over the same positions. a40738e then made a concurrent pass safe
 * by checking whether the trade already closed, which removed the hazard the heartbeat existed for —
 * and left it renewing indefinitely, starving the queue.
 *
 * So this asserts the decision from both sides: the lock is still taken and released, and nothing
 * renews it. Adding a heartbeat back without re-reading why it was removed should fail here.
 */
describe('the sl-tp-monitor job lock', () => {
  it('is still taken and released, so two passes cannot start at once', () => {
    expect(src).toContain("acquireJobLock('sltp_monitor'")
    expect(src).toContain("releaseJobLock('sltp_monitor')")
  })

  it('does NOT heartbeat, because a stuck pass must be replaceable', () => {
    expect(src).not.toContain('startJobLockHeartbeat')
    expect(src).not.toContain('clearInterval')
  })

  it('keeps the TTL aligned with the Go client timeout that abandons the request', () => {
    // main.go passes 120 seconds to makeRequest for this worker. If one moves, the other should too:
    // a lock shorter than the client lets a slow pass be replaced while its caller still waits, and a
    // longer one holds the queue past the point anyone is listening.
    expect(src).toMatch(/acquireJobLock\('sltp_monitor',\s*120\)/)
  })
})
