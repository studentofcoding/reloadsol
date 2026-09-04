import type { AppNetwork } from '@/utils/app-network'

export function buySpendQueryKey(chain: AppNetwork): 'sol' | 'eth' {
  return chain === 'robinhood' ? 'eth' : 'sol'
}

export function readBuySpendAmount(
  search: { get: (key: string) => string | null },
  chain: AppNetwork,
): string | null {
  const key = buySpendQueryKey(chain)
  const primary = search.get(key)
  if (primary && !Number.isNaN(+primary) && +primary > 0) return primary
  if (chain === 'robinhood') {
    const legacy = search.get('sol')
    if (legacy && !Number.isNaN(+legacy) && +legacy > 0) return legacy
  }
  return null
}

export function applyBuySpendParam(
  params: URLSearchParams,
  chain: AppNetwork,
  amount: string,
): void {
  params.delete('sol')
  params.delete('eth')
  if (amount && !Number.isNaN(+amount) && +amount > 0) {
    params.set(buySpendQueryKey(chain), amount)
  }
}
