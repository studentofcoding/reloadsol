import { describe, expect, it } from 'vitest'
import { collectListenChannelPeers } from './route'

describe('collectListenChannelPeers', () => {
  it('prefers active strategy peers and keeps first non-empty per source', () => {
    const channels = collectListenChannelPeers({
      a: {
        is_active: true,
        config: {
          entry: { listenChannelPeers: { TRENDINGSSOL: '@trendingssol' } },
        },
      },
      b: {
        is_active: true,
        config: {
          entry: { listenChannelPeers: { TRENDINGSSOL: '@other' } },
        },
      },
    })
    expect(channels).toEqual([{ source: 'TRENDINGSSOL', peer: '@trendingssol' }])
  })

  it('falls back to inactive when no active peers', () => {
    const channels = collectListenChannelPeers({
      a: {
        is_active: false,
        config: {
          entry: { listenChannelPeers: { TRENDINGSSOL: '@from-inactive' } },
        },
      },
    })
    expect(channels).toEqual([{ source: 'TRENDINGSSOL', peer: '@from-inactive' }])
  })
})
