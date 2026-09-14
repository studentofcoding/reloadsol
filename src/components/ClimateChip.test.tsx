import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClimateChipView } from '@/components/ClimateChip'
import { InsightNetworkTabs } from '@/components/insight/InsightNetworkTabs'
import {
  insightPress,
  insightEnter,
} from '@/components/insight/insight-ui'

describe('ClimateChipView copy', () => {
  it('renders Not safe + De-risk · H 0.5 without a Climate prefix', () => {
    const html = renderToStaticMarkup(
      <ClimateChipView
        label="Not safe"
        subtitle="De-risk · H 0.5"
        ariaLabel="Not safe, De-risk · H 0.5"
      />,
    )
    expect(html).toContain('Not safe')
    expect(html).toContain('De-risk · H 0.5')
    expect(html).not.toMatch(/>Climate /)
    expect(html).not.toContain('Climate Not safe')
    expect(html).not.toContain('Climate De-risk')
  })

  it('uses the binary label as the accessible name when no subtitle', () => {
    const html = renderToStaticMarkup(
      <ClimateChipView label="Safe" subtitle={null} />,
    )
    expect(html).toContain('aria-label="Safe"')
    expect(html).not.toContain('Climate Safe')
  })
})

describe('InsightNetworkTabs', () => {
  it('keeps Sol/RH as a per-network switch and disables RH when gated', () => {
    const html = renderToStaticMarkup(
      <InsightNetworkTabs network="sol" canUseRh={false} onSelect={() => {}} />,
    )
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('Sol')
    expect(html).toContain('RH')
    expect(html).toContain('disabled')
  })
})

describe('insight motion tokens', () => {
  it('never uses transition-all, ease-in, or scale(0) entries', () => {
    expect(insightPress).not.toContain('transition-all')
    expect(insightPress).not.toMatch(/ease-in(?!-out)/)
    expect(insightPress).toContain('scale-[0.96]')
    expect(insightEnter).toBe('insight-enter')
  })
})
