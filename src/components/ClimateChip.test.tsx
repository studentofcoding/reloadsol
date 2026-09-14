import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClimateChipView } from '@/components/ClimateChip'
import { InsightNetworkTabs } from '@/components/insight/InsightNetworkTabs'
import {
  chromeFloat,
  chromePrimary,
  chromeNetworkSeg,
  insightCard,
  insightPress,
  insightEnter,
  insightRow,
  navSticky,
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
    expect(html).toContain('tabular-nums')
    expect(html).not.toMatch(/>Climate /)
    expect(html).not.toContain('Climate Not safe')
    expect(html).not.toContain('Climate De-risk')
  })

  it('uses light-legible tones on the Header chrome and dark tones inline', () => {
    const header = renderToStaticMarkup(
      <ClimateChipView label="Not safe" subtitle="De-risk · H 0.5" layout="header" />,
    )
    const inline = renderToStaticMarkup(
      <ClimateChipView label="Not safe" subtitle="De-risk · H 0.5" layout="inline" />,
    )
    expect(header).toContain('text-amber-900')
    expect(inline).toContain('text-amber-200')
    expect(header).not.toContain('transition-all')
    expect(inline).not.toContain('transition-all')
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

describe('Apple HIG chrome and materials', () => {
  it('keeps blur on floating Header chrome only', () => {
    expect(chromeFloat).toContain('sticky')
    expect(chromeFloat).toContain('bg-transparent')
    expect(chromePrimary).toContain('chrome-primary')
    expect(chromeNetworkSeg).toContain('chrome-network-seg')
    expect(insightCard).not.toMatch(/backdrop-blur|blur-/)
    expect(insightRow).not.toMatch(/backdrop-blur|blur-/)
    expect(navSticky).toContain('top-[var(--chrome-header-height)]')
    expect(navSticky).not.toMatch(/backdrop-blur/)
  })

  it('uses concentric secondary cards and fine-pointer row hover', () => {
    expect(insightCard).toContain('rounded-[24px]')
    expect(insightCard).toContain('p-3')
    expect(insightRow).toContain('duration-100')
    expect(insightRow).toContain('fine-hover:')
  })
})
