import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TokenLocateResult } from '@/strategies/token-locate'
import { TokenMapBoardView } from '@/components/token-locate/TokenMapBoard'

vi.mock('@/components/signals/shared/GmgnChartEmbed', () => ({
  default: () => <div>gmgn-chart-embed</div>,
}))

vi.mock('@/components/token-locate/GmgnTokenStatsGrid', () => ({
  default: ({ variant }: { variant?: string }) => <div>stats-{variant}</div>,
}))

vi.mock('@/components/token-locate/OhlcRugPanel', () => ({
  default: () => <div>ohlc-rug-panel</div>,
}))

vi.mock('@/components/token-locate/TokenMapLane', () => ({
  default: ({ label }: { label: string }) => <div>lane:{label}</div>,
}))

vi.mock('@/components/token-locate/TokenMapStrategyChart', () => ({
  default: () => <div>strategy-chart</div>,
}))

const result = {
  tokenAddress: 'CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU',
  symbol: 'TEST',
  strategyPresence: [],
  links: {
    chart: 'https://chart.example/token',
    jupiter: 'https://jup.example/token',
    strategies: '/dev/outcomes',
  },
} as TokenLocateResult

function markup(banned: boolean) {
  return renderToStaticMarkup(
    <TokenMapBoardView
      result={result}
      activities={[]}
      newIds={new Set()}
      showGmgn
      onShowGmgnChange={() => {}}
      concBan={
        banned
          ? { banned: true, reasons: ['Bundlers H. 63.5% > 50%'] }
          : null
      }
      onConcentrationBan={() => {}}
    />,
  )
}

describe('TokenMapBoardView concentration ban', () => {
  it('keeps the full freeview when banned and shows the banner', () => {
    const html = markup(true)

    expect(html).toContain('Banned: concentration')
    expect(html).toContain('Bundlers H. 63.5% &gt; 50%')
    expect(html).toContain('GMGN chart')
    expect(html).toContain('href="https://chart.example/token"')
    expect(html).toContain('href="https://jup.example/token"')
    expect(html).toContain('href="/dev/outcomes"')
    expect(html).toContain('>Chart<')
    expect(html).toContain('>Jupiter<')
    expect(html).toContain('>Outcomes<')
    expect(html).toContain('gmgn-chart-embed')
    expect(html).toContain('strategy-chart')
    expect(html).toContain('stats-rail')
    expect(html).toContain('ohlc-rug-panel')
    expect(html).toContain('lane:MCap tracker')
    expect(html).toContain('lane:Signals')
    expect(html).toContain('lane:GMGN')
    expect(html).toContain('lane:Trending')
    expect(html).toContain('lane:DLMM')
    expect(html).toContain('lane:Social')
    expect(html).not.toContain('max-w-xs')
  })

  it('omits the banner when the token is not concentration-banned', () => {
    const html = markup(false)

    expect(html).not.toContain('Banned: concentration')
    expect(html).toContain('gmgn-chart-embed')
    expect(html).toContain('strategy-chart')
    expect(html).toContain('stats-rail')
    expect(html).toContain('lane:Social')
  })
})
