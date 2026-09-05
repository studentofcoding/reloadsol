import { describe, expect, it } from 'vitest'
import { txSignatureExplorer } from './tx-explorer'

describe('txSignatureExplorer', () => {
  it('links Robinhood EVM hashes to Blockscout', () => {
    const hash =
      '0x7b98e8d1c15e8136206c6938eb34bc879afc32ee837594e3a4e84815edb90751'
    expect(txSignatureExplorer(hash)).toEqual({
      href: `https://robinhoodchain.blockscout.com/tx/${hash}`,
      label: 'View on Blockscout',
    })
  })

  it('keeps Solana signatures on Solscan', () => {
    const sig = '5VERv8NMvzbJMEkV8xnrLkEaWKbB9CNnhpT1KVvqJxwQ'
    expect(txSignatureExplorer(sig).href).toBe(`https://solscan.io/tx/${sig}`)
    expect(txSignatureExplorer(sig).label).toBe('View on Solscan')
  })
})
