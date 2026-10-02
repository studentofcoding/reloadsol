"use client";

import React from "react";
import type { TokenFilterConfig } from "@/strategies/types";

const inputClass =
  "w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white";

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <h4 className="text-xs font-semibold text-gray-300 mb-2">{title}</h4>
      {children}
    </div>
  );
}

export function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 text-xs">{children}</div>;
}

/**
 * T4 step 2 of SPEC-config-taxonomy: the block every strategy in a family repeats renders once, above
 * the family's grid, sourced from the family's `DEFAULT_*` export. Read-only by construction — there is
 * no input here to wire, so it can only state what the code default is, never change it. A card's own
 * section is then visibly the per-strategy override this row is the thing for.
 */
export function FamilyDefaultRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 rounded border border-gray-700 bg-gray-800/50 px-3 py-2 text-xs text-gray-400">
      <span className="font-mono text-[10px] uppercase tracking-wide text-gray-500 mr-2">
        family default · {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Where a field's current value came from — T7 of SPEC-config-taxonomy, and the rule the whole
 * taxonomy rests on: a number on this page must say whether the system is using the stored value or
 * falling back, because those read identically and mean completely different things. `inherited` is
 * the family-default case: a strategy rendering a value it never overrode.
 *
 * Optional on every field, so a call site that does not know its source renders exactly as before
 * rather than lying about it.
 */
type FieldSource = 'stored' | 'defaults' | 'inherited'

const SOURCE_STYLE: Record<FieldSource, string> = {
  stored: 'text-emerald-300/80',
  defaults: 'text-amber-300/80',
  inherited: 'text-gray-400',
}

/**
 * T4 step 2 (second half) of SPEC-config-taxonomy: a strategy card shows only the fields it actually
 * overrides, and the family defaults it merely inherits sit behind one toggle. The scope is a *card*, so
 * the weights and shared-filter panels are not wrapped by it and render exactly as they did before.
 */
const CardFieldScope = React.createContext<{ revealed: boolean } | null>(null)

export function CardFieldReveal({
  sources,
  children,
}: {
  /** This strategy's own `id.field -> stored | defaults`, already sliced from its family's map. */
  sources?: Record<string, 'stored' | 'defaults'>
  children: React.ReactNode
}) {
  const [revealed, setRevealed] = React.useState(false)
  const inherited = Object.values(sources ?? {}).filter((v) => v === 'defaults').length
  return (
    <CardFieldScope.Provider value={{ revealed }}>
      {inherited > 0 && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="text-[11px] text-blue-400 underline mb-3 block"
        >
          {revealed ? `hide inherited (${inherited})` : `show inherited (${inherited})`}
        </button>
      )}
      {children}
    </CardFieldScope.Provider>
  )
}

/** Inherited greyed, overrides bold — only inside a card. Outside one the label is unchanged. */
function fieldTone(scope: { revealed: boolean } | null, source?: FieldSource): string {
  if (!scope) return 'text-gray-400'
  if (source === 'inherited') return 'text-gray-600'
  if (source === 'stored') return 'font-semibold text-gray-100'
  return 'text-gray-400'
}

/**
 * A `Section` that disappears when the strategy overrode none of it, so an unoverridden block leaves no
 * empty titled shell behind. The card's reveal toggle brings it back, greyed.
 */
export function CardSection({
  title,
  overridden,
  children,
}: {
  title: string
  overridden: boolean
  children: React.ReactNode
}) {
  const scope = React.useContext(CardFieldScope)
  if (scope && !overridden && !scope.revealed) return null
  return <Section title={title}>{children}</Section>
}

export function SourceTag({ source }: { source?: FieldSource }) {
  if (!source) return null
  return (
    <span className={`ml-1 font-mono text-[10px] ${SOURCE_STYLE[source]}`} title={`value from ${source}`}>
      {source}
    </span>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  colSpan,
  step,
  source,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  colSpan?: 1 | 2
  step?: string
  source?: FieldSource
}) {
  const scope = React.useContext(CardFieldScope)
  if (scope && source === 'inherited' && !scope.revealed) return null
  return (
    <label className={`${fieldTone(scope, source)} ${colSpan === 2 ? "col-span-2" : ""}`}>
      {label}
      <SourceTag source={source} />
      <input
        type="number"
        step={step ?? "any"}
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  colSpan,
  source,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  colSpan?: 1 | 2
  source?: FieldSource
}) {
  const scope = React.useContext(CardFieldScope)
  if (scope && source === 'inherited' && !scope.revealed) return null
  return (
    <label
      className={`${fieldTone(scope, source)} flex items-center gap-2 ${colSpan === 2 ? "col-span-2" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-gray-600"
      />
      {label}
      <SourceTag source={source} />
    </label>
  );
}

export function formatFilterSummary(filtering?: TokenFilterConfig): string {
  if (!filtering?.enabled) return "Filtering disabled";
  const parts: string[] = [];
  if (filtering.mcap?.min != null || filtering.mcap?.max != null) {
    const min = filtering.mcap.min != null ? `${(filtering.mcap.min / 1000).toFixed(0)}k` : "?";
    const max =
      filtering.mcap.max != null ? `${(filtering.mcap.max / 1_000_000).toFixed(1)}M` : "?";
    parts.push(`mcap ${min}–${max}`);
  }
  if (filtering.organicScore?.min != null) {
    parts.push(`organic ≥${filtering.organicScore.min}`);
  }
  if (filtering.topHoldersPercentage?.max != null) {
    parts.push(`holders ≤${filtering.topHoldersPercentage.max}%`);
  }
  return parts.join(" · ") || "Custom filters";
}

export function parseOptionalFloat(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = parseFloat(trimmed);
  return Number.isNaN(n) ? undefined : n;
}

export function parseOptionalInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = parseInt(trimmed, 10);
  return Number.isNaN(n) ? undefined : n;
}
