import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import robots from '@/app/robots'
import { canonical, noIndexRobots, publicPageMetadata, SITE_URL } from '@/lib/seo'

describe('public SEO helpers', () => {
  it('builds canonical URLs on reloadsol.app', () => {
    expect(SITE_URL).toBe('https://reloadsol.app')
    expect(canonical('/buy')).toBe('https://reloadsol.app/buy')
    const meta = publicPageMetadata({
      title: 'Buy multiple tokens',
      description: 'Split spend across tokens.',
      path: '/buy',
    })
    expect(meta.alternates?.canonical).toBe('/buy')
    expect(meta.openGraph?.url).toBe('https://reloadsol.app/buy')
  })

  it('keeps private surfaces noindex', () => {
    expect(noIndexRobots).toMatchObject({ index: false, follow: false })
  })

  it('disallows /dev, /api, history, pnl, and charts from crawlers', () => {
    const body = robots()
    const rule = Array.isArray(body.rules) ? body.rules[0] : body.rules
    expect(rule.disallow).toEqual(
      expect.arrayContaining(['/dev/', '/api/', '/history', '/pnl', '/chart/']),
    )
    expect(body.sitemap).toBe('https://reloadsol.app/sitemap.xml')
  })

  it('ships a skip link to the single root main landmark', () => {
    const layout = readFileSync(resolve(process.cwd(), 'src/app/layout.tsx'), 'utf8')
    expect(layout).toContain('href="#main-content"')
    expect(layout).toContain('Skip to main content')
    expect(layout).toContain('id="main-content"')
    expect(layout).toContain('template: "%s · ReloadSOL"')
  })
})
