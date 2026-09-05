export type TokenSearchMapView = 'freeview' | 'list'

export type TokenSearchDetailHref =
  `/dev/search-token/detail?address=${string}`

export function tokenSearchDetailHref(
  address: string,
  view?: TokenSearchMapView,
): TokenSearchDetailHref {
  const q = new URLSearchParams({ address })
  if (view) q.set('view', view)
  return `/dev/search-token/detail?${q}` as TokenSearchDetailHref
}
