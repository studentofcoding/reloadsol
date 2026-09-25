import { describe, expect, it } from 'vitest'
import { pnlShareService } from './pnl-share-service'

describe('exactPnlPercentage', () => {
  it('returns profit and loss from cost versus proceeds', () => {
    expect(pnlShareService.exactPnlPercentage(1, 1.5)).toBeCloseTo(50)
    expect(pnlShareService.exactPnlPercentage(1, 0.6)).toBeCloseTo(-40)
  })

  it('returns null when cost is missing', () => {
    expect(pnlShareService.exactPnlPercentage(0, 1)).toBeNull()
    expect(pnlShareService.exactPnlPercentage(-1, 1)).toBeNull()
  })
})
