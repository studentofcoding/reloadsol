import SignalsHub from "@/components/signals/SignalsHub";

export const dynamic = "force-dynamic";

export default function SignalsPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Signals</h1>
      <p className="mb-6 text-sm text-gray-400">
        Trading signals, live trending, chart board, and mcap tracker in one
        place.
      </p>
      <SignalsHub />
    </div>
  );
}
