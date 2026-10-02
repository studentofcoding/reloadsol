import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StrategyLifecycleGrid } from './StrategyLifecycleGrid'

const rows = [
  { id: 'mcap_enter_first_seen', is_active: true },
  { id: 'search_mcap_first_seen_sl_30_tp150_h48', is_active: false },
  { id: 'search_mcap_first_seen_sl_30_tp200_h48', is_active: true },
]

const render = (lastOutcomeAt: Record<string, string> | null) =>
  renderToStaticMarkup(
    <StrategyLifecycleGrid
      items={rows}
      lastOutcomeAt={lastOutcomeAt}
      renderCard={(s) => <div data-card={s.id}>{s.id}</div>}
    />,
  )

describe('StrategyLifecycleGrid', () => {
  it('tags each card and folds the retired search variant into the Archived group', () => {
    const html = render({ mcap_enter_first_seen: '2026-10-02T00:00:00Z' })
    expect(html).toContain('data-lifecycle="active"')
    expect(html).toContain('data-lifecycle="trial"')
    expect(html).toContain('data-lifecycle="retired"')
    const [main, archived] = html.split('<details')
    expect(main).toContain('data-card="mcap_enter_first_seen"')
    expect(main).toContain('data-card="search_mcap_first_seen_sl_30_tp200_h48"')
    expect(main).not.toContain('tp150')
    expect(archived).toContain('Archived search variants (1)')
    expect(archived).toContain('data-card="search_mcap_first_seen_sl_30_tp150_h48"')
  })

  it('renders every card exactly once — archiving hides nothing from the page', () => {
    const html = render({})
    for (const r of rows) expect(html.split(`data-card="${r.id}"`)).toHaveLength(2)
  })

  it('no archived group when nothing is archived', () => {
    const html = renderToStaticMarkup(
      <StrategyLifecycleGrid items={[rows[0]!]} lastOutcomeAt={{}} renderCard={(s) => <i>{s.id}</i>} />,
    )
    expect(html).not.toContain('<details')
  })

  it('lookup unavailable: retired still shown, trial/active not guessed', () => {
    const html = render(null)
    expect(html).toContain('data-lifecycle="retired"')
    expect(html).not.toContain('data-lifecycle="trial"')
    expect(html).not.toContain('data-lifecycle="active"')
  })
})
