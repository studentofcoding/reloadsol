"use client";

import React from "react";
import {
  partitionByLifecycle,
  type StrategyLifecycle,
} from "@/strategies/strategy-lifecycle";

const BADGE: Record<StrategyLifecycle, { cls: string; title: string }> = {
  retired: { cls: "text-gray-400", title: "inactive — retired, not failing" },
  active: { cls: "text-emerald-300/80", title: "active, and has a closed outcome" },
  trial: { cls: "text-amber-300/80", title: "active, no closed outcome yet — still being proven" },
};

/** Same words, same colours as the Workers table's lifecycle word (`b0a9d9d`). */
export function LifecycleBadge({ lifecycle }: { lifecycle: StrategyLifecycle | null }) {
  if (!lifecycle) return null;
  const { cls, title } = BADGE[lifecycle];
  return (
    <span className={`font-mono text-[10px] ${cls}`} title={title} data-lifecycle={lifecycle}>
      {lifecycle}
    </span>
  );
}

/**
 * SPEC-config-taxonomy-v1 T5 (rule 4): a family's strategy cards, each tagged with its lifecycle, with
 * retired `search_*` experiment clones folded into a collapsed "Archived" group instead of rendering a
 * full editing surface that does nothing. Archived = a view over `is_active`; the cards are still
 * there (and reactivation still works) — nothing is deleted.
 *
 * `lastOutcomeAt` is `null` while the lookup is loading or failed: retired is still shown (it needs no
 * lookup), trial/active are simply omitted rather than guessed.
 */
export function StrategyLifecycleGrid<T extends { id: string; is_active: boolean }>({
  items,
  lastOutcomeAt,
  renderCard,
}: {
  items: readonly T[];
  lastOutcomeAt: Readonly<Record<string, string>> | null;
  renderCard: (item: T) => React.ReactNode;
}) {
  const { live, archived } = partitionByLifecycle(items, lastOutcomeAt);
  const cell = (item: T, lifecycle: StrategyLifecycle | null) => (
    <div key={item.id} className="space-y-1">
      <LifecycleBadge lifecycle={lifecycle} />
      {renderCard(item)}
    </div>
  );
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {live.map(({ strategy, lifecycle }) => cell(strategy, lifecycle))}
      </div>
      {archived.length > 0 ? (
        <details className="mt-4" data-testid="archived-search-variants">
          <summary className="cursor-pointer text-sm text-gray-400">
            Archived search variants ({archived.length}) — retired, not deleted
          </summary>
          <div className="grid gap-4 md:grid-cols-2 mt-3">
            {archived.map(({ strategy, lifecycle }) => cell(strategy, lifecycle))}
          </div>
        </details>
      ) : null}
    </>
  );
}
