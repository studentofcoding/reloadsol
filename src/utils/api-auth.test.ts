import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it } from 'vitest'
import { enforceApiAccess, isServiceAuthorizedRequest } from './api-auth'

const prev = {
  trending: process.env.TRENDING_TRACKER_SECRET,
  pnl: process.env.PNL_UPDATE_SECRET,
}

afterEach(() => {
  process.env.TRENDING_TRACKER_SECRET = prev.trending
  process.env.PNL_UPDATE_SECRET = prev.pnl
})

describe('isServiceAuthorizedRequest', () => {
  it('does not treat a spoofable cron User-Agent as auth', () => {
    process.env.TRENDING_TRACKER_SECRET = 'real-secret'
    const req = new NextRequest('http://localhost/api/signals', {
      headers: { 'user-agent': 'reloadsol-cron-service/1.0' },
    })
    expect(isServiceAuthorizedRequest(req)).toBe(false)
  })

  it('accepts a matching bearer secret', () => {
    process.env.TRENDING_TRACKER_SECRET = 'real-secret'
    const req = new NextRequest('http://localhost/api/signals', {
      headers: { authorization: 'Bearer real-secret' },
    })
    expect(isServiceAuthorizedRequest(req)).toBe(true)
  })

  it('rejects /api/trade/test without a wallet session', () => {
    delete process.env.TRENDING_TRACKER_SECRET
    delete process.env.PNL_UPDATE_SECRET
    delete process.env.DLMM_API_PASSWORD
    const req = new NextRequest('http://localhost/api/trade/test')
    const res = enforceApiAccess(req)
    expect(res?.status).toBe(401)
  })
})
