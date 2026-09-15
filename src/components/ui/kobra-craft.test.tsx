import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SegPillList from '@/components/ui/SegPillList'
import SwitchControl from '@/components/ui/SwitchControl'
import FocusRelay from '@/components/ui/FocusRelay'
import InsightPressButton from '@/components/insight/InsightPressButton'

describe('Kobra-ported primitives', () => {
  it('renders a sliding tab pill with named parts and equal-column index', () => {
    const html = renderToStaticMarkup(
      <SegPillList
        variant="insight"
        ariaLabel="Insight network"
        value="sol"
        onSelect={() => {}}
        options={[
          { id: 'sol', label: 'Sol' },
          { id: 'robinhood', label: 'RH', disabled: true },
        ]}
      />,
    )
    expect(html).toContain('data-slot="tabs"')
    expect(html).toContain('data-slot="tabs-indicator"')
    expect(html).toContain('data-slot="tabs-trigger"')
    expect(html).toContain('--tab-count:2')
    expect(html).toContain('--tab-i:0')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('disabled')
  })

  it('slides the pill by index when the second tab is active', () => {
    const html = renderToStaticMarkup(
      <SegPillList
        variant="chrome"
        ariaLabel="Network"
        value="robinhood"
        onSelect={() => {}}
        options={[
          { id: 'sol', label: 'Sol' },
          { id: 'robinhood', label: 'RH' },
        ]}
      />,
    )
    expect(html).toContain('data-variant="chrome"')
    expect(html).toContain('--tab-i:1')
  })

  it('exposes switch parts without changing checked semantics', () => {
    const html = renderToStaticMarkup(
      <SwitchControl checked={false} onCheckedChange={() => {}}>
        Use GMGN
      </SwitchControl>,
    )
    expect(html).toContain('data-slot="switch"')
    expect(html).toContain('data-slot="switch-control"')
    expect(html).toContain('data-slot="switch-thumb"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Use GMGN')
  })

  it('wraps fields with a shared morphing focus ring', () => {
    const html = renderToStaticMarkup(
      <FocusRelay>
        <input aria-label="amount" />
      </FocusRelay>,
    )
    expect(html).toContain('data-slot="focus-relay"')
    expect(html).toContain('data-slot="focus-ring"')
    expect(html).toContain('data-active="false"')
  })

  it('keeps dense chrome on 0.96 and primary punch on Kinetics squish', () => {
    const dense = renderToStaticMarkup(<InsightPressButton>Note</InsightPressButton>)
    const punch = renderToStaticMarkup(
      <InsightPressButton punch>Buy</InsightPressButton>,
    )
    expect(dense).toContain('data-slot="button"')
    expect(dense).toContain('scale-[0.96]')
    expect(punch).toContain('cta-press')
    expect(punch).not.toContain('scale-[0.96]')
  })
})
