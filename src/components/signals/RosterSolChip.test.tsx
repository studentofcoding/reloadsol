import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import RosterSolChip from './RosterSolChip'

const MINT = 'nDZknLvfFRp5rgUHdzTrQsmSY5NKzoavqdLjSHVpump'

describe('RosterSolChip', () => {
  it('keeps the select action as a button and adds a separate chart link', () => {
    const html = renderToStaticMarkup(
      <RosterSolChip mint={MINT} metaSymbol="POPCAT" onSelect={vi.fn()} />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('POPCAT')
    expect(html).toContain(`href="/chart/${MINT}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('aria-label="Open chart for POPCAT"')
  })

  it('reflects the selected state for the sell toggle', () => {
    const on = renderToStaticMarkup(
      <RosterSolChip mint={MINT} onSelect={vi.fn()} selected />,
    )
    const off = renderToStaticMarkup(<RosterSolChip mint={MINT} onSelect={vi.fn()} />)
    expect(on).toContain('aria-pressed="true"')
    expect(off).toContain('aria-pressed="false"')
  })
})
