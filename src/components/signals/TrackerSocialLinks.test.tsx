import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TrackerSocialLinks } from './TrackerSocialLinks'

describe('TrackerSocialLinks', () => {
  it('renders links when social present', () => {
    const html = renderToStaticMarkup(
      <TrackerSocialLinks
        social={{
          twitter: '@foo',
          telegram: 'bar',
          website: 'https://ex.com',
        }}
        organicScore={80}
      />,
    )
    expect(html).toContain('https://x.com/foo')
    expect(html).toContain('https://t.me/bar')
    expect(html).toContain('https://ex.com')
    expect(html).toContain('Twitter')
    expect(html).toContain('Telegram')
    expect(html).toContain('Website')
    expect(html).toContain('organic')
    expect(html).toContain('80')
  })

  it('renders nothing without social or organic', () => {
    const html = renderToStaticMarkup(<TrackerSocialLinks />)
    expect(html).toBe('')
  })
})
