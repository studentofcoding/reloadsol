import { describe, expect, it } from 'vitest'
import {
  alreadyEmptyNotice,
  clmmPositionKey,
  findOrphanOpenMarkIds,
  isAlreadyEmptyCloseError,
} from './rh-clmm-already-empty'

describe('rh-clmm-already-empty', () => {
  it('detects close.ts already-empty errors', () => {
    expect(
      isAlreadyEmptyCloseError('Position #403759 not found or already empty'),
    ).toBe(true)
    expect(isAlreadyEmptyCloseError('Position #1 NOT FOUND OR ALREADY EMPTY')).toBe(
      true,
    )
    expect(isAlreadyEmptyCloseError('insufficient funds')).toBe(false)
  })

  it('finds open marks missing from live keys', () => {
    const live = new Set([clmmPositionKey('v3', '100')])
    const orphans = findOrphanOpenMarkIds(
      [
        { id: 'a', protocol: 'v3', token_id: '100' },
        { id: 'b', protocol: 'v3', token_id: '403759' },
        { id: 'c', protocol: 'v4', token_id: '9' },
      ],
      live,
    )
    expect(orphans).toEqual([
      { markId: 'b', tokenId: '403759' },
      { markId: 'c', tokenId: '9' },
    ])
  })

  it('formats soft notices', () => {
    expect(alreadyEmptyNotice(['403759'])).toBe(
      'Position #403759 already empty — marked closed',
    )
    expect(alreadyEmptyNotice(['1', '2'])).toBe(
      '2 positions already empty — marked closed (e.g. #1)',
    )
  })
})
