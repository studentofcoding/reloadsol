import TokenLocateHub from '@/components/token-locate/TokenLocateHub'

export const dynamic = 'force-dynamic'

type PageProps = {
  searchParams: Promise<{ address?: string; view?: string }>
}

export default async function TokenSearchPage({ searchParams }: PageProps) {
  const params = await searchParams
  const initialAddress = params.address?.trim() ?? ''
  const initialView =
    params.view === 'freeview' || params.view === 'list' ? params.view : undefined

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Token map</h1>
      <p className="mb-6 text-sm text-gray-400">
        Search by mint address. Toggle <span className="text-gray-300">Freeview</span> for
        strategy lanes with live activity, or <span className="text-gray-300">List</span> for
        the classic locate table and raw Jupiter / DB dumps. Pin mints to switch quickly.
      </p>
      <TokenLocateHub initialAddress={initialAddress} initialView={initialView} />
    </div>
  )
}
