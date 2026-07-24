import { describe, expect, it } from 'vitest'
import { getGmgnKlineUrl, inferGmgnChain } from './gmgn'

describe('inferGmgnChain', () => {
  it('maps EVM addresses to robinhood', () => {
    expect(inferGmgnChain('0xAbCDEF0000000000000000000000000000000001')).toBe(
      'robinhood',
    )
  })

  it('maps sol mints to sol', () => {
    expect(
      inferGmgnChain('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
    ).toBe('sol')
  })
})

describe('getGmgnKlineUrl', () => {
  it('embeds robinhood path for 0x tokens when chain omitted', () => {
    const url = getGmgnKlineUrl('0x1111111111111111111111111111111111111111', {
      interval: '1D',
    })
    expect(url).toContain('/kline/robinhood/0x1111111111111111111111111111111111111111')
  })

  it('honors explicit chain', () => {
    const url = getGmgnKlineUrl('0x1111111111111111111111111111111111111111', {
      chain: 'eth',
    })
    expect(url).toContain('/kline/eth/')
  })
})
