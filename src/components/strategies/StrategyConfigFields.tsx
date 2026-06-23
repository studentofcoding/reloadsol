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

export function NumberField({
  label,
  value,
  onChange,
  colSpan,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  colSpan?: 1 | 2;
  step?: string;
}) {
  return (
    <label className={`text-gray-400 ${colSpan === 2 ? "col-span-2" : ""}`}>
      {label}
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
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  colSpan?: 1 | 2;
}) {
  return (
    <label
      className={`text-gray-400 flex items-center gap-2 ${colSpan === 2 ? "col-span-2" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-gray-600"
      />
      {label}
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
