import { describe, expect, it } from 'vitest'
import { socialDomainAndKind } from './token-map-activity'

describe('socialDomainAndKind', () => {
  it('routes gmgn_hot to gmgn lane', () => {
    expect(socialDomainAndKind('gmgn_hot')).toEqual({
      domain: 'gmgn',
      kind: 'gmgn_hot',
    })
  })

  it('routes telegram sources to social lane', () => {
    expect(socialDomainAndKind('telegram')).toEqual({
      domain: 'social',
      kind: 'social_event',
    })
  })
})
