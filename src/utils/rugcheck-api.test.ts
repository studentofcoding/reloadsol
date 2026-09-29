import { afterEach, describe, expect, it } from 'vitest'
import { rugcheckMaxReqPerSec, rugcheckMinIntervalMs } from '@/utils/rugcheck-api'

describe('rugcheck rate cap', () => {
  afterEach(() => {
    delete process.env.RUGCHECK_MAX_REQ_PER_SEC
  })

  it('defaults to ~3 rps (≈30% of the measured ~10 rps clean ceiling)', () => {
    delete process.env.RUGCHECK_MAX_REQ_PER_SEC
    expect(rugcheckMaxReqPerSec()).toBe(3)
    expect(rugcheckMinIntervalMs()).toBe(334)
  })

  it('honours the env override', () => {
    process.env.RUGCHECK_MAX_REQ_PER_SEC = '2'
    expect(rugcheckMaxReqPerSec()).toBe(2)
    expect(rugcheckMinIntervalMs()).toBe(500)
  })

  it('falls back to the default on a non-positive value', () => {
    process.env.RUGCHECK_MAX_REQ_PER_SEC = '0'
    expect(rugcheckMaxReqPerSec()).toBe(3)
  })
})
