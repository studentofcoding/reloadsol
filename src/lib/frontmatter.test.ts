import { describe, expect, it } from 'vitest'
import { parseFrontMatter } from '@/lib/frontmatter'

describe('parseFrontMatter', () => {
  it('parses quoted blog front matter', () => {
    const raw = `---
title: 'Hello'
date: '2024-05-20'
author: 'Team'
excerpt: 'Summary'
---

Body text`

    const { data, content } = parseFrontMatter(raw)
    expect(data.title).toBe('Hello')
    expect(data.date).toBe('2024-05-20')
    expect(content.trim()).toBe('Body text')
  })

  it('returns raw content when front matter missing', () => {
    const { data, content } = parseFrontMatter('# No front matter')
    expect(data).toEqual({})
    expect(content).toBe('# No front matter')
  })
})
