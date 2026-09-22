import { describe, expect, it } from 'vitest'
import { buildMcapListWhere } from './list-where'
import { mcapLabelFilterSql } from '@/utils/tracker-label'

describe('mcap list label filter', () => {
  it('label=rugged binds label = $n and does not select potential', () => {
    const built = buildMcapListWhere({ label: 'rugged' })
    expect(built.error).toBeUndefined()
    expect(built.sql).toContain('label = $1')
    expect(built.values).toEqual(['rugged'])
    expect(built.sql).not.toContain('potential')
    expect(built.values).not.toContain('potential')
  })

  it('label=unlabeled is IS NULL', () => {
    const built = buildMcapListWhere({ label: 'unlabeled' })
    expect(built.sql).toContain('label IS NULL')
    expect(built.values).toEqual([])
  })

  it('label=rug is rejected', () => {
    const built = buildMcapListWhere({ label: 'rug' })
    expect(built.error).toMatch(/Invalid label/)
    expect(mcapLabelFilterSql('rug', 1)).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/Invalid label/) }),
    )
  })

  it('omitted label adds no label predicate', () => {
    const built = buildMcapListWhere({ chain: 'sol' })
    expect(built.error).toBeUndefined()
    expect(built.sql).not.toMatch(/label/i)
    expect(built.values).toEqual(['sol'])
  })

  it('All is the same as omitting the label', () => {
    const all = buildMcapListWhere({ label: 'all', chain: 'sol' })
    const omitted = buildMcapListWhere({ chain: 'sol' })
    expect(all.sql).toBe(omitted.sql)
    expect(all.values).toEqual(omitted.values)
  })

  it('label ANDs with chain so pagination where matches the chip', () => {
    const built = buildMcapListWhere({ chain: 'sol', label: 'potential' })
    expect(built.sql).toContain('chain = $1')
    expect(built.sql).toContain('label = $2')
    expect(built.values).toEqual(['sol', 'potential'])
  })
})
