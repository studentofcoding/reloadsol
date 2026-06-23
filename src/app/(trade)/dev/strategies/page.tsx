import StrategyAdminHub from "@/components/strategies/StrategyAdminHub";

export const dynamic = "force-dynamic";

export default function StrategiesAdminPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="mb-2 text-2xl font-semibold text-white">Strategy Admin</h1>
      <p className="mb-6 text-sm text-gray-400">
        Central registry for trending bot strategies. Signals and DLMM thresholds editable here;
        outcomes and workers on Reports / Workers tabs. See docs/algo_overview.md.
      </p>
      <StrategyAdminHub />
    </div>
  );
}
