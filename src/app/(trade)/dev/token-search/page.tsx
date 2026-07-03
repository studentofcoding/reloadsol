import TokenLocateHub from "@/components/token-locate/TokenLocateHub";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ address?: string }>;
};

export default async function TokenSearchPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const initialAddress = params.address?.trim() ?? "";

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Token search</h1>
      <p className="mb-6 text-sm text-gray-400">
        Search by mint address to see strategy presence, social ingest, and live Jupiter metadata.
        Raw API responses are grouped by data tier (raw Jupiter, enrichment, internal DB).
      </p>
      <TokenLocateHub initialAddress={initialAddress} />
    </div>
  );
}
