import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))
vi.mock('@/utils/telegram', () => ({ sendTelegramAlert: vi.fn(async () => true), isTelegramConfigured: vi.fn(() => true) }))
vi.mock('@/utils/unified-logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import {
  __clearOpenStallProvidersForTests,
  checkStaleFeeds,
  checkStuckLocks,
  formatOpenReport,
  jakartaHour,
  loadOpenStats,
  registerOpenStallProvider,
  runOpenReport,
  type OpenStats,
} from './open-reporter'

const stats = (o: Partial<OpenStats> = {}): OpenStats => ({
  windowHours: 1,
  opened: 9,
  failed: 1,
  skipped: 40,
  topFailed: [{ reason: 'price_moved_gt_5pct', count: 1 }],
  topSkipped: [{ reason: 'size_stand_down <x>', count: 30 }],
  attemptsAvailable: true,
  ...o,
})

type Row = Record<string, unknown>
function fakeQ(map: Array<[RegExp, Row[] | Error]>) {
  const calls: string[] = []
  const q = vi.fn(async (sql: string) => {
    calls.push(sql)
    for (const [re, rows] of map) {
      if (re.test(sql)) {
        if (rows instanceof Error) throw rows
        return { rows }
      }
    }
    return { rows: [] }
  })
  return { q: q as never, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  __clearOpenStallProvidersForTests()
})

describe('formatOpenReport', () => {
  it('prints success/fail percentages over opened+failed and escapes HTML', () => {
    const t = formatOpenReport('last 1h', stats())
    expect(t).toContain('Success <b>90.0%</b>')
    expect(t).toContain('Fail <b>10.0%</b>')
    expect(t).toContain('(9/10)')
    expect(t).toContain('size_stand_down &lt;x&gt; ×30')
  })
  it('says so when there were no attempts and flags a missing table', () => {
    const t = formatOpenReport('last 24h', stats({ opened: 0, failed: 0, skipped: 0, topFailed: [], topSkipped: [], attemptsAvailable: false }))
    expect(t).toContain('No open attempts')
    expect(t).toContain('apply db/init/65')
  })
})

describe('loadOpenStats', () => {
  it('counts opened from sl_tp_positions and failed/skipped from final attempts', async () => {
    const { q } = fakeQ([
      [/FROM sl_tp_positions/, [{ n: 7 }]],
      [/FROM position_open_attempts/, [
        { outcome: 'failed', reason: 'a', n: 2 },
        { outcome: 'skipped', reason: 'cap', n: 11 },
        { outcome: 'skipped', reason: 'size', n: 3 },
      ]],
    ])
    const s = await loadOpenStats(1, q)
    expect(s).toMatchObject({ opened: 7, failed: 2, skipped: 14, attemptsAvailable: true })
    expect(s.topSkipped[0]).toEqual({ reason: 'cap', count: 11 })
  })
  it('degrades to opens-only when the attempts table is missing', async () => {
    const { q } = fakeQ([
      [/FROM sl_tp_positions/, [{ n: 3 }]],
      [/FROM position_open_attempts/, new Error('relation does not exist')],
    ])
    expect(await loadOpenStats(1, q)).toMatchObject({ opened: 3, attemptsAvailable: false })
  })
})

describe('alerts', () => {
  it('flags a stuck lock and honours the ignore list', async () => {
    const rows = [
      { job_name: 'trending_cycle', locked_by: 'h:1:2', held_min: 120 },
      { job_name: 'evidence_archive', locked_by: 'h:1:3', held_min: 90 },
    ]
    const { q } = fakeQ([[/FROM bot_job_locks/, rows]])
    const items = await checkStuckLocks({ OPEN_REPORT_LOCK_IGNORE: 'evidence_archive' }, q)
    expect(items.map((i) => i.key)).toEqual(['stuck_lock:trending_cycle'])
    expect(items[0].text).toContain('held 120 min')
  })

  it('flags stale feeds past their limit, and a feed with no recent row; an unreadable one only logs', async () => {
    const { q } = fakeQ([
      [/FROM token_ohlc_bars/, [{ age_min: 40 }]],
      [/FROM token_mcap_tracking/, [{ age_min: null }]],
      [/FROM copier_runs/, new Error('relation "copier_runs" does not exist')],
    ])
    const items = await checkStaleFeeds({}, q)
    expect(items.map((i) => i.key)).toEqual(['stale_feed:ohlc_bars', 'stale_feed:mcap_tracker'])
  })

  it('does not flag fresh feeds', async () => {
    const { q } = fakeQ([
      [/FROM token_ohlc_bars/, [{ age_min: 1 }]],
      [/FROM token_mcap_tracking/, [{ age_min: 2 }]],
      [/FROM copier_runs/, [{ age_min: 10 }]],
    ])
    expect(await checkStaleFeeds({}, q)).toEqual([])
  })
})

describe('jakartaHour', () => {
  it('converts UTC to WIB', () => {
    expect(jakartaHour(new Date('2026-10-04T01:00:00Z'))).toBe(8)
    expect(jakartaHour(new Date('2026-10-04T17:30:00Z'))).toBe(0)
  })
})

describe('runOpenReport', () => {
  const base = [
    [/FROM sl_tp_positions/, [{ n: 5 }]],
    [/FROM position_open_attempts/, [{ outcome: 'failed', reason: 'x', n: 1 }]],
    [/FROM watchdog_alert_state/, []], // never alerted -> due
    [/FROM bot_job_locks/, []],
    [/FROM token_ohlc_bars/, [{ age_min: 1 }]],
    [/FROM token_mcap_tracking/, [{ age_min: 1 }]],
    [/FROM copier_runs/, [{ age_min: 1 }]],
  ] as Array<[RegExp, Row[]]>

  it('is a no-op when disabled', async () => {
    const send = vi.fn(async () => true)
    const r = await runOpenReport('auto', { env: { OPEN_REPORT_ENABLED: '0' }, send, q: fakeQ(base).q })
    expect(r.enabled).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('does nothing (and says why) when Telegram is not configured', async () => {
    const send = vi.fn(async () => true)
    const r = await runOpenReport('auto', { env: {}, send, q: fakeQ(base).q, telegramConfigured: false })
    expect(r.skipped).toContain('telegram_not_configured')
    expect(send).not.toHaveBeenCalled()
  })

  it('posts the hourly report and records the cooldown; not the daily one outside 08:00 WIB', async () => {
    const send = vi.fn(async () => true)
    const { q, calls } = fakeQ(base)
    const r = await runOpenReport('auto', { env: {}, send, q, now: new Date('2026-10-04T05:00:00Z') }) // 12:00 WIB
    expect(r.posts.map((p) => p.key)).toEqual(['hourly'])
    expect(send).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.includes('INSERT INTO watchdog_alert_state'))).toBe(true)
  })

  it('also posts the daily report at 08:00 WIB', async () => {
    const send = vi.fn(async () => true)
    const r = await runOpenReport('auto', { env: {}, send, q: fakeQ(base).q, now: new Date('2026-10-04T01:10:00Z') })
    expect(r.posts.map((p) => p.key)).toEqual(['hourly', 'daily'])
  })

  it('respects the cooldown and does not record one after a failed send', async () => {
    const send = vi.fn(async () => true)
    const cooling = fakeQ([[/FROM watchdog_alert_state/, [{ due: false }]], ...base.filter(([re]) => !/watchdog/.test(String(re)))])
    const r = await runOpenReport('hourly', { env: {}, send, q: cooling.q })
    expect(r.skipped).toContain('hourly:cooldown')
    expect(send).not.toHaveBeenCalled()

    const failing = vi.fn(async () => false)
    const f = fakeQ(base)
    const r2 = await runOpenReport('hourly', { env: {}, send: failing, q: f.q })
    expect(r2.posts[0].sent).toBe(false)
    expect(f.calls.some((c) => c.includes('INSERT INTO watchdog_alert_state'))).toBe(false)
  })

  it('dry-run returns the texts and neither sends nor writes', async () => {
    const send = vi.fn(async () => true)
    const { q, calls } = fakeQ(base)
    const r = await runOpenReport('hourly', { env: {}, send, q, dry: true, telegramConfigured: false })
    expect(r.posts[0].text).toContain('Paper opens')
    expect(send).not.toHaveBeenCalled()
    expect(calls.some((c) => c.includes('watchdog_alert_state'))).toBe(false)
  })

  it('fires the at-cap/no-opens alert only through a registered provider (the #138 hook)', async () => {
    const send = vi.fn(async () => true)
    const none = await runOpenReport('alerts', { env: {}, send, q: fakeQ(base).q })
    expect(none.posts).toEqual([])
    registerOpenStallProvider({ name: 'cap_stall', check: async () => ({ stalled: true, text: 'At cap, no opens for 6h: signals_default' }) })
    const some = await runOpenReport('alerts', { env: {}, send, q: fakeQ(base).q })
    expect(some.posts.map((p) => p.key)).toEqual(['alert:stall:cap_stall'])
    expect(some.posts[0].text).toContain('At cap, no opens for 6h')
  })

  it('each part can be switched off on its own', async () => {
    const send = vi.fn(async () => true)
    const r = await runOpenReport('auto', { env: { OPEN_REPORT_HOURLY: '0', OPEN_REPORT_ALERTS: '0' }, send, q: fakeQ(base).q, now: new Date('2026-10-04T05:00:00Z') })
    expect(r.posts).toEqual([])
  })
})
