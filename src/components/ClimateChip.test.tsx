import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClimateChipView, ClimateRegimeLiveDetail } from '@/components/ClimateChip'
import LiveNumber, {
  LIVE_NUMBER_COMPACT_USD,
  LIVE_NUMBER_COUNT,
  LIVE_NUMBER_H,
  LIVE_NUMBER_SCORE,
} from '@/components/insight/LiveNumber'
import { InsightNetworkTabs } from '@/components/insight/InsightNetworkTabs'
import {
  chromeFloat,
  chromePrimary,
  chromeNetworkSeg,
  insightCard,
  insightPress,
  insightEnter,
  insightRow,
  navChromeItem,
  navSticky,
} from '@/components/insight/insight-ui'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('ClimateChipView copy', () => {
  it('renders Safe + Chop mode without a Climate prefix', () => {
    const html = renderToStaticMarkup(
      <ClimateChipView
        label="Safe"
        subtitle="Chop mode"
        ariaLabel="Safe, Chop mode"
      />,
    )
    expect(html).toContain('Safe')
    expect(html).toContain('Chop mode')
    expect(html).not.toContain('Range · H')
    expect(html).not.toMatch(/>Climate /)
    expect(html).not.toContain('Climate Safe')
  })

  it('renders headline from ClimateRegimeLiveDetail instead of rolling H', () => {
    const html = renderToStaticMarkup(
      <ClimateChipView
        label="Safe"
        subtitle={
          <ClimateRegimeLiveDetail
            headline="Chop mode"
            state="Range"
            h={0.52}
          />
        }
        ariaLabel="Safe, Chop mode"
      />,
    )
    expect(html).toContain('Chop mode')
    expect(html).not.toContain('Range · ')
    expect(html).not.toContain('sfi-numbers')
    expect(html).not.toMatch(/>Climate /)
  })

  it('falls back to state · H when headline is missing', () => {
    const html = renderToStaticMarkup(
      <ClimateChipView
        label="Not safe"
        subtitle={<ClimateRegimeLiveDetail state="De-risk" h={0.48} />}
        ariaLabel="Not safe, De-risk · H 0.5"
      />,
    )
    expect(html).toContain('Not safe')
    expect(html).toContain('De-risk · ')
    expect(html).toContain('sfi-numbers')
    expect(html).toContain('H ')
    expect(html).toContain('0.5')
    expect(html).not.toMatch(/>Climate /)
  })

  it('uses light-legible tones on the Header chrome and dark tones inline', () => {
    const header = renderToStaticMarkup(
      <ClimateChipView label="Not safe" subtitle="BTC is dumping — beware" layout="header" />,
    )
    const inline = renderToStaticMarkup(
      <ClimateChipView label="Not safe" subtitle="BTC is dumping — beware" layout="inline" />,
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

describe('LiveNumber formats', () => {
  it('SSRs compact USD, scores, counts, and H without a flash of empty', () => {
    const usd = renderToStaticMarkup(
      <LiveNumber value={20_000} format={LIVE_NUMBER_COMPACT_USD} />,
    )
    const score = renderToStaticMarkup(
      <LiveNumber value={70} format={LIVE_NUMBER_SCORE} />,
    )
    const count = renderToStaticMarkup(
      <LiveNumber value={3} format={LIVE_NUMBER_COUNT} />,
    )
    const h = renderToStaticMarkup(
      <LiveNumber value={0.48} format={LIVE_NUMBER_H} prefix="H " />,
    )
    expect(usd).toContain('sfi-numbers')
    expect(usd).toMatch(/\$20K|\$20.0K/)
    expect(score).toContain('70')
    expect(count).toContain('3')
    expect(h).toContain('H ')
    expect(h).toContain('0.5')
  })

  it('falls back to an em dash when the value is missing', () => {
    const html = renderToStaticMarkup(<LiveNumber value={null} />)
    expect(html).toContain('—')
    expect(html).not.toContain('sfi-numbers')
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
    expect(insightPress).not.toContain('scale-[0.97]')
    expect(insightPress).toContain('ease-out-strong')
    expect(insightEnter).toBe('insight-enter')
    expect(navChromeItem).toContain('scale-[0.96]')
    expect(navChromeItem).not.toContain('transition-all')
  })
})

describe('better-ui + emil-design-eng CSS tokens', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8')

  it('locks better-ui cubic-bezier(0.2, 0, 0, 1) and emil cubic-bezier(0.23, 1, 0.32, 1)', () => {
    expect(css).toContain('--ease-out: cubic-bezier(0.23, 1, 0.32, 1)')
    expect(css).toContain('--ease-out-ui: cubic-bezier(0.2, 0, 0, 1)')
  })

  it('enters from scale(0.97)+opacity with 12px y, not scale(0)', () => {
    expect(css).toContain('translateY(12px) scale(0.97)')
    expect(css).toContain('animation: insight-enter 220ms var(--ease-out) both')
    expect(css).toContain('animation-delay: 100ms')
    expect(css).not.toContain('translateY(12px) scale(0)')
  })

  it('uses better-ui icon swap 0.25 / blur(4px) / 300ms', () => {
    expect(css).toMatch(/insight-icon-swap[\s\S]*transition-duration: 300ms/)
    expect(css).toMatch(/insight-icon-swap[\s\S]*var\(--ease-out-ui\)/)
  })

  it('caps @sfinterface/numbers roll to the shipped insight UI budget', () => {
    expect(css).toContain('--sfi-resolve: 240ms')
    expect(css).toContain('.insight-live-number')
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
