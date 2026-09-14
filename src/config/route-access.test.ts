import { describe, expect, it } from 'vitest'
import { isDevRoute } from './route-access'

describe('isDevRoute', () => {
  it('gates /dev/insight as a whitelist-only surface', () => {
    expect(isDevRoute('/dev/insight')).toBe(true)
    expect(isDevRoute('/dev/insight/extra')).toBe(true)
    expect(isDevRoute('/buy')).toBe(false)
  })
})
