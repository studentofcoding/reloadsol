import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LP_TERMINAL_BASE_URL,
  getLpTerminalBaseUrl,
  getLpTerminalIndexerBase,
  getLpTerminalIndexerUrl,
  getLpTerminalPoolsUrl,
} from './lp-terminal'

describe('lp-terminal', () => {
  it('defaults base URL', () => {
    expect(getLpTerminalBaseUrl({})).toBe(DEFAULT_LP_TERMINAL_BASE_URL)
  })

  it('prefers NEXT_PUBLIC over LP_TERMINAL_BASE_URL', () => {
    expect(
      getLpTerminalBaseUrl({
        NEXT_PUBLIC_LP_TERMINAL_BASE_URL: 'https://lp.example/',
        LP_TERMINAL_BASE_URL: 'https://ignored.example',
      }),
    ).toBe('https://lp.example')
  })

  it('builds pools deep link with optional token q=', () => {
    expect(getLpTerminalPoolsUrl(null, {})).toBe(
      `${DEFAULT_LP_TERMINAL_BASE_URL}/#pools`,
    )
    expect(
      getLpTerminalPoolsUrl('0xabc', {
        NEXT_PUBLIC_LP_TERMINAL_BASE_URL: 'https://lp.example',
      }),
    ).toBe('https://lp.example/#pools?q=0xabc')
  })

  it('indexer URL optional vs base default', () => {
    expect(getLpTerminalIndexerUrl({})).toBeNull()
    expect(getLpTerminalIndexerBase({})).toBe(DEFAULT_LP_TERMINAL_BASE_URL)
    expect(
      getLpTerminalIndexerUrl({ LP_TERMINAL_INDEXER_URL: 'http://127.0.0.1:8787/' }),
    ).toBe('http://127.0.0.1:8787')
    expect(
      getLpTerminalIndexerBase({ LP_TERMINAL_INDEXER_URL: 'http://127.0.0.1:8787/' }),
    ).toBe('http://127.0.0.1:8787')
  })
})
