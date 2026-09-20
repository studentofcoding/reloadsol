import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TrackerHoldingChip } from './TrackerHoldingChip'

describe('TrackerHoldingChip', () => {
  it('shows Holding $… when the mint is held', () => {
    const html = renderToStaticMarkup(
      <TrackerHoldingChip holding={{ usd: 12.34, amount: 8 }} />,
    )
    expect(html).toContain('Holding:')
    expect(html).toContain('$12.34')
  })

  it('omits the chip when not held', () => {
    expect(renderToStaticMarkup(<TrackerHoldingChip />)).toBe('')
    expect(
      renderToStaticMarkup(<TrackerHoldingChip holding={{ usd: 9, amount: 0 }} />),
    ).toBe('')
  })
})
