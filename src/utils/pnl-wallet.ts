export type PnlTradingRecord = {
  data: {
    operationType: 'buy' | 'sell' | 'close'
    tokens: Array<{
      mintAddress: string
      priceUsd?: number
      tokenAmount?: number
    }>
  }
}

/** Average-cost lots: later buys update basis; sells consume remaining size. */
export function calculateWalletPnL(records: PnlTradingRecord[]): number {
  let totalPnL = 0
  const lots = new Map<string, { avgPrice: number; amount: number }>()

  for (const record of records) {
    const data = record.data

    if (data.operationType === 'buy') {
      for (const token of data.tokens) {
        if (!token.priceUsd || !token.tokenAmount) continue
        const prev = lots.get(token.mintAddress)
        if (!prev) {
          lots.set(token.mintAddress, {
            avgPrice: token.priceUsd,
            amount: token.tokenAmount,
          })
          continue
        }
        const amount = prev.amount + token.tokenAmount
        lots.set(token.mintAddress, {
          avgPrice:
            (prev.avgPrice * prev.amount + token.priceUsd * token.tokenAmount) /
            amount,
          amount,
        })
      }
    } else if (
      data.operationType === 'sell' ||
      data.operationType === 'close'
    ) {
      for (const token of data.tokens) {
        if (!token.priceUsd || !token.tokenAmount) continue
        const prev = lots.get(token.mintAddress)
        if (!prev || prev.amount <= 0) continue
        const sold = Math.min(prev.amount, token.tokenAmount)
        totalPnL += (token.priceUsd - prev.avgPrice) * sold
        const remaining = prev.amount - sold
        if (remaining <= 0) lots.delete(token.mintAddress)
        else lots.set(token.mintAddress, { avgPrice: prev.avgPrice, amount: remaining })
      }
    }
  }

  return totalPnL
}
