import { describe, expect, it } from 'vitest'
import { toUtcIso } from '@/utils/datetime'
import { mcapPatternRefreshSql } from './mcap-patterns-24h'

/** Mirrors first_seen_at coercion in refreshMcapSocialPatterns24h. */
function toPgTimestamptzParam(value: unknown, fallback: string): string {
  const raw = value ?? fallback
  return raw instanceof Date ? toUtcIso(raw) : String(raw)
}

describe('mcap pattern timestamptz params', () => {
  it('serializes pg Date objects to ISO, not locale GMT+0700 strings', () => {
    const d = new Date('2026-07-05T01:49:00+07:00')
    expect(String(d)).toMatch(/GMT\+0700/)
    expect(toPgTimestamptzParam(d, 'fallback')).toBe('2026-07-04T18:49:00.000Z')
    expect(toPgTimestamptzParam(d, 'fallback')).not.toContain('GMT+0700')
  })

  it('passes through ISO strings unchanged', () => {
    const iso = '2026-07-04T18:49:00.000Z'
    expect(toPgTimestamptzParam(iso, 'fallback')).toBe(iso)
  })
})

describe('mcapPatternRefreshSql', () => {
  it('scopes source/delete/upsert by chain and composite conflict key', () => {
    const sql = mcapPatternRefreshSql('robinhood')
    expect(sql.chain).toBe('robinhood')
    expect(sql.sourceSelect).toContain('chain = $2')
    expect(sql.staleDelete).toContain('chain = $2')
    expect(sql.neutralDelete).toContain('chain = $2')
    expect(sql.upsert).toContain('ON CONFLICT (token_address, chain)')
    expect(sql.upsert).toContain('chain,')
  })
})
