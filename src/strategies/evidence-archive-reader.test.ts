import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { sha256Hex } from '@/utils/s3-sigv4'
import { createMemoryStore, listManifests, readManifest, replayRows, verifyObject } from './evidence-archive-reader'
import { objectKey } from './evidence-archive'

const rows = [
  { token_address: 'A', interval: '1m', timestamp: '2026-10-03T00:00:00.000Z', close: 1 },
  { token_address: 'B', interval: '1m', timestamp: '2026-10-03T00:01:00.000Z', close: 2 },
  { token_address: 'A', interval: '1m', timestamp: '2026-10-03T00:02:00.000Z', close: 3 },
]
const raw = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const gz = gzipSync(raw)
const key = objectKey('p', 'token_ohlc_bars', '2026-10-03')
const entry = {
  dataset: 'token_ohlc_bars',
  status: 'ok',
  object_key: key,
  rows: 3,
  bytes_gz: gz.length,
  sha256_gz: sha256Hex(gz),
  sha256_raw: sha256Hex(raw),
  min_ts: null,
  max_ts: null,
}

describe('evidence archive reader', () => {
  it('verifies a good object and flags tampering / missing / wrong row count', async () => {
    const store = createMemoryStore({ [key]: gz })
    await expect(verifyObject(store, entry, '2026-10-03')).resolves.toMatchObject({ ok: true, rows: 3 })
    await expect(verifyObject(store, { ...entry, rows: 4 }, '2026-10-03')).resolves.toMatchObject({ ok: false })
    await expect(verifyObject(store, { ...entry, sha256_gz: 'dead' }, '2026-10-03')).resolves.toMatchObject({
      ok: false,
      problem: 'sha256 mismatch (gz)',
    })
    await expect(verifyObject(createMemoryStore(), entry, '2026-10-03')).resolves.toMatchObject({
      ok: false,
      problem: 'object missing',
    })
  })

  it('replays rows filtered by mint and time window', async () => {
    const store = createMemoryStore({ [key]: gz })
    const a: unknown[] = []
    for await (const r of replayRows(store, 'p', 'token_ohlc_bars', '2026-10-03', { mint: 'A' })) a.push(r)
    expect(a).toHaveLength(2)
    const w: unknown[] = []
    for await (const r of replayRows(store, 'p', 'token_ohlc_bars', '2026-10-03', {
      fromIso: '2026-10-03T00:01:00.000Z',
      toIso: '2026-10-03T00:01:30.000Z',
    })) w.push(r)
    expect(w).toHaveLength(1)
  })

  it('throws loudly when the day was never archived', async () => {
    const gen = replayRows(createMemoryStore(), 'p', 'token_ohlc_bars', '2026-10-03')
    await expect(gen.next()).rejects.toThrow(/no archive object/)
  })

  it('lists and reads manifests', async () => {
    const mk = 'p/manifests/2026/10/03/manifest-20261004T030000Z.json'
    const store = createMemoryStore({ [mk]: Buffer.from(JSON.stringify({ version: 1, day: '2026-10-03', datasets: [entry] })) })
    await expect(listManifests(store, 'p', '2026-10-03')).resolves.toEqual([mk])
    await expect(readManifest(store, mk)).resolves.toMatchObject({ day: '2026-10-03' })
  })
})
