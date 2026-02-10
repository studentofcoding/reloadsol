import TradingSignals from "@/components/TradingSignals";

export const dynamic = "force-dynamic";

export default function SignalsPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-2xl font-semibold mb-4">Trading Signals</h1>
      <p className="text-sm text-gray-600 mb-6">
        Live signals generated from market cap tracker data. Adjust filters and
        refresh to update.
      </p>
      <TradingSignals />
    </div>
  );
}
