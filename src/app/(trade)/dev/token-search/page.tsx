import { permanentRedirect } from 'next/navigation'


type PageProps = {
  searchParams: Promise<{ address?: string; view?: string }>
}

export default async function TokenSearchRedirect({ searchParams }: PageProps) {
  const params = await searchParams
  const q = new URLSearchParams()
  const address = params.address?.trim()
  if (address) q.set('address', address)
  if (params.view === 'freeview' || params.view === 'list') q.set('view', params.view)
  const qs = q.toString()
  permanentRedirect(`/dev/search-token/detail${qs ? `?${qs}` : ''}`)
}
