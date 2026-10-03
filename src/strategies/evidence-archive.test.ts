import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import {
  ARCHIVE_DATASETS,
  archiveConfigFromEnv,
  buildPageSql,
  dayWindow,
  eligibleDays,
  exportDatasetDay,
  isArchiveEnabled,
  manifestKey,
  objectKey,
  runEvidenceArchive,
  runStampFor,
  type DatasetSpec,
  type QueryFn,
} from './evidence-archive'
import { createMemoryStore } from './evidence-archive-reader'

const BARS = ARCHIVE_DATASETS.find((d) => d.name === 'token_ohlc_bars') as DatasetSpec

/** Fake Postgres: serves a fixed bar table through the keyset SQL the exporter issues. */
function fakeDb(opts: { bars: Array<{ token_address: string; interval: string; timestamp: string }>; done?: string[]; missing?: string[] }) {
  const runs: unknown[][] = []
  const done = new Set(opts.done ?? [])
  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('to_regclass')) {
      const t = String(params[0]).replace('public.', '')
      return { rows: [{ r: opts.missing?.includes(t) ? null : t }] }
    }
    if (sql.includes('FROM evidence_archive_runs')) {
      const ds = params[0]
      return { rows: [...done].filter((k) => k.startsWith(`${ds}|`)).map((k) => ({ day: k.split('|')[1] })) }
    }
    if (sql.startsWith('INSERT INTO evidence_archive_runs')) {
      runs.push(params)
      if (params[2] === 'ok' || params[2] === 'empty') done.add(`${params[0]}|${params[1]}`)
      return { rows: [] }
    }
    if (sql.includes('FROM "token_ohlc_bars"')) {
      const [start, end, ...cur] = params as string[]
      let rows = opts.bars
        .filter((b) => b.timestamp >= start && b.timestamp < end)
        .sort((a, b) => (a.timestamp + a.token_address + a.interval < b.timestamp + b.token_address + b.interval ? -1 : 1))
      if (cur.length) rows = rows.filter((b) => b.timestamp + b.token_address + b.interval > cur[0] + cur[1] + cur[2])
      const limit = Number(/LIMIT (\d+)/.exec(sql)![1])
      return {
        rows: rows.slice(0, limit).map((b) => ({ j: { ...b, close: 1 }, k0: b.timestamp, k1: b.token_address, k2: b.interval })),
      }
    }
    return { rows: [] }
  }) as unknown as QueryFn
  return { query, runs, done }
}

const NOW = new Date('2026-10-04T03:00:00Z')
const config = archiveConfigFromEnv({ EVIDENCE_ARCHIVE_DATASETS: 'token_ohlc_bars', EVIDENCE_ARCHIVE_PAGE_SIZE: '2' })

describe('pure helpers', () => {
  it('only offers COMPLETE UTC days past the grace window, oldest first', () => {
    // 2026-10-04 03:00Z, grace 2h -> last complete day is 10-03
    expect(eligibleDays({ nowMs: NOW.getTime(), graceHours: 2, lookbackDays: 3, maxDays: 9 })).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ])
    // 01:00Z with 2h grace: 10-03 ended < 2h ago, so it is NOT offered yet
    expect(
      eligibleDays({ nowMs: Date.parse('2026-10-04T01:00:00Z'), graceHours: 2, lookbackDays: 2, maxDays: 9 }),
    ).toEqual(['2026-10-01', '2026-10-02'])
  })
  it('skips days already done and caps per run', () => {
    expect(
      eligibleDays({ nowMs: NOW.getTime(), graceHours: 2, lookbackDays: 3, maxDays: 1, already: new Set(['2026-10-01']) }),
    ).toEqual(['2026-10-02'])
  })
  it('keys include the date and manifests are unique per run', () => {
    expect(objectKey('p/v1', 'token_ohlc_bars', '2026-10-02')).toBe(
      'p/v1/token_ohlc_bars/2026/10/02/token_ohlc_bars-2026-10-02.ndjson.gz',
    )
    expect(runStampFor(new Date('2026-10-04T02:50:09.123Z'))).toBe('20261004T025009Z')
    expect(manifestKey('p/v1', '2026-10-02', '20261004T025009Z')).toBe('p/v1/manifests/2026/10/02/manifest-20261004T025009Z.json')
    expect(dayWindow('2026-10-02')).toEqual({ startIso: '2026-10-02T00:00:00.000Z', endIso: '2026-10-03T00:00:00.000Z' })
  })
  it('builds a keyset page query over the whole key', () => {
    const sql = buildPageSql(BARS, true, 500)
    expect(sql).toMatch(/\(t\."timestamp", t\."token_address", t\."interval"\) > \(\$3::timestamptz, \$4::text, \$5::text\)/)
    expect(sql).toContain('LIMIT 500')
    expect(buildPageSql(BARS, false, 5)).not.toContain('> ($3')
  })
  it('is off unless EVIDENCE_ARCHIVE_ENABLED=1, and the kill switch wins', () => {
    expect(isArchiveEnabled({})).toBe(false)
    expect(isArchiveEnabled({ EVIDENCE_ARCHIVE_ENABLED: '1' })).toBe(true)
    expect(isArchiveEnabled({ EVIDENCE_ARCHIVE_ENABLED: '1', EVIDENCE_ARCHIVE_KILL_SWITCH: '1' })).toBe(false)
  })
})

describe('exportDatasetDay', () => {
  const bars = ['a', 'b', 'c', 'd', 'e'].map((m, i) => ({
    token_address: m,
    interval: '1m',
    timestamp: `2026-10-03T00:0${i}:00.000Z`,
  }))

  it('pages through every row and returns a verifiable gz NDJSON', async () => {
    const { query } = fakeDb({ bars })
    const out = await exportDatasetDay(query, BARS, '2026-10-03', { pageSize: 2, maxObjectBytes: 1 << 20 })
    expect(out.rows).toBe(5)
    expect(out.minTs).toBe('2026-10-03T00:00:00.000Z')
    expect(out.maxTs).toBe('2026-10-03T00:04:00.000Z')
    const lines = gunzipSync(out.body).toString('utf8').trim().split('\n')
    expect(lines).toHaveLength(5)
    expect(JSON.parse(lines[4]).token_address).toBe('e')
    expect(out.sha256Gz).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses to build an object larger than the cap instead of exhausting memory', async () => {
    const { query } = fakeDb({ bars })
    await expect(exportDatasetDay(query, BARS, '2026-10-03', { pageSize: 2, maxObjectBytes: 1 })).rejects.toThrow(/exceeds/)
  })
})

describe('runEvidenceArchive', () => {
  const bars = Array.from({ length: 5 }, (_, i) => ({
    token_address: `m${i}`,
    interval: '1m',
    timestamp: `2026-10-03T00:0${i}:00.000Z`,
  }))

  it('writes each complete day once, writes a manifest, and records the ledger', async () => {
    const db = fakeDb({ bars })
    const store = createMemoryStore()
    const s = await runEvidenceArchive({ query: db.query, store, now: NOW, config })
    expect(s.failed).toBe(0)
    const key = objectKey(config.prefix, 'token_ohlc_bars', '2026-10-03')
    expect(store.objects.has(key)).toBe(true)
    const manifestObj = [...store.objects.keys()].find((k) => k.includes('/manifests/2026/10/03/'))!
    const manifest = JSON.parse(store.objects.get(manifestObj)!.toString('utf8'))
    expect(manifest.datasets[0]).toMatchObject({ dataset: 'token_ohlc_bars', status: 'ok', rows: 5, object_key: key })
    expect(manifest.datasets[0].sha256_gz).toMatch(/^[0-9a-f]{64}$/)
    // 10-01 and 10-02 have no rows -> recorded as empty (final), not uploaded
    expect(s.results.filter((r) => r.status === 'empty').map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02'])
    expect(db.runs.length).toBe(3)
  })

  it('is idempotent: a second run touches nothing', async () => {
    const db = fakeDb({ bars })
    const store = createMemoryStore()
    await runEvidenceArchive({ query: db.query, store, now: NOW, config })
    const before = new Map(store.objects)
    const s2 = await runEvidenceArchive({ query: db.query, store, now: new Date(NOW.getTime() + 3_600_000), config })
    expect(s2.days).toEqual([])
    expect([...store.objects.keys()]).toEqual([...before.keys()])
  })

  it('never overwrites: a differing object at the same key is reported as a conflict and left intact', async () => {
    const db = fakeDb({ bars })
    const key = objectKey(config.prefix, 'token_ohlc_bars', '2026-10-03')
    const store = createMemoryStore({ [key]: Buffer.from('DIFFERENT') })
    const s = await runEvidenceArchive({ query: db.query, store, now: NOW, config })
    expect(store.objects.get(key)!.toString()).toBe('DIFFERENT')
    expect(s.results.find((r) => r.day === '2026-10-03')?.status).toBe('conflict')
    expect(s.failed).toBeGreaterThan(0)
  })

  it('records a failed upload loudly and does not mark the day done', async () => {
    const db = fakeDb({ bars })
    const store = createMemoryStore()
    store.putIfAbsent = async () => {
      throw new Error('R2 PUT -> 500')
    }
    const s = await runEvidenceArchive({ query: db.query, store, now: NOW, config })
    expect(s.results.find((r) => r.day === '2026-10-03')).toMatchObject({ status: 'failed', detail: 'R2 PUT -> 500' })
    expect(db.done.has('token_ohlc_bars|2026-10-03')).toBe(false)
  })

  it('skips optional tables that do not exist yet', async () => {
    const db = fakeDb({ bars, missing: ['token_entry_context', 'position_open_attempts'] })
    const store = createMemoryStore()
    const s = await runEvidenceArchive({
      query: db.query,
      store,
      now: NOW,
      config: { ...config, datasets: ['token_entry_context', 'position_open_attempts'] },
    })
    expect(s.results).toEqual([])
  })
})
