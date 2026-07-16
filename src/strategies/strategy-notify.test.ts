import { describe, expect, it } from 'vitest'
import {
  mergeNotifyConfig,
  notifySyncForActive,
  readNotifyFlags,
} from './strategy-notify'

describe('readNotifyFlags', () => {
  it('defaults both on when unset', () => {
    expect(readNotifyFlags(undefined)).toEqual({ telegram: true, ui: true })
    expect(readNotifyFlags({})).toEqual({ telegram: true, ui: true })
  })

  it('honors explicit false', () => {
    expect(readNotifyFlags({ telegram: false, ui: true })).toEqual({
      telegram: false,
      ui: true,
    })
  })
})

describe('notifySyncForActive', () => {
  it('turns both on when activating', () => {
    expect(notifySyncForActive(true)).toEqual({ telegram: true, ui: true })
  })
  it('turns both off when deactivating', () => {
    expect(notifySyncForActive(false)).toEqual({ telegram: false, ui: false })
  })
})

describe('mergeNotifyConfig', () => {
  it('merges override onto base', () => {
    expect(
      mergeNotifyConfig({ telegram: true, ui: true }, { telegram: false }),
    ).toEqual({ telegram: false, ui: true })
  })
})
