"use client";

import RawJsonPanel from "@/components/token-locate/RawJsonPanel";
import {
  buildCombinedInternalExport,
  buildMcapExportPayload,
  buildSocialExportPayload,
  copyJson,
  downloadJson,
  hasCombinedExportableData,
  hasExportableData,
  shortMintFilename,
  type InternalExportMeta,
} from "@/components/token-locate/internal-export";
import type { RawSection } from "@/strategies/token-locate";
import { useMemo, useState } from "react";

type InternalDbSectionGroupProps = {
  title: string;
  sections: RawSection[];
  tokenAddress: string;
  exportedAt: string;
};

function ToolbarButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded bg-blue-600 px-3 py-1 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

export default function InternalDbSectionGroup({
  title,
  sections,
  tokenAddress,
  exportedAt,
}: InternalDbSectionGroupProps) {
  const [open, setOpen] = useState(true);

  const meta: InternalExportMeta = useMemo(
    () => ({ tokenAddress, exportedAt }),
    [tokenAddress, exportedAt],
  );

  const mcapData = useMemo(
    () => buildMcapExportPayload(meta, sections),
    [meta, sections],
  );
  const socialData = useMemo(
    () => buildSocialExportPayload(meta, sections),
    [meta, sections],
  );
  const combinedData = useMemo(
    () => buildCombinedInternalExport(meta, sections),
    [meta, sections],
  );

  const filePrefix = shortMintFilename(tokenAddress);
  const canMcap = hasExportableData(mcapData);
  const canSocial = hasExportableData(socialData);
  const canCombined = hasCombinedExportableData(sections);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-3 flex w-full items-center gap-2 text-left text-sm font-medium uppercase tracking-wide text-gray-500 hover:text-gray-400"
      >
        <span>{open ? "▼" : "▶"}</span>
        {title}
        <span className="text-xs normal-case text-gray-600">({sections.length})</span>
      </button>
      {open ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 rounded-lg border border-gray-700 bg-gray-900/40 px-4 py-3">
            <ToolbarButton
              label="Copy Mcap JSON"
              disabled={!canMcap}
              onClick={() => copyJson(mcapData)}
            />
            <ToolbarButton
              label="Copy Social JSON"
              disabled={!canSocial}
              onClick={() => copyJson(socialData)}
            />
            <ToolbarButton
              label="Copy combined"
              disabled={!canCombined}
              onClick={() => copyJson(combinedData)}
            />
            <span className="mx-1 hidden h-6 w-px bg-gray-700 sm:inline" />
            <ToolbarButton
              label="Export Mcap"
              disabled={!canMcap}
              onClick={() =>
                downloadJson(`${filePrefix}-mcap-tracker.json`, mcapData)
              }
            />
            <ToolbarButton
              label="Export Social"
              disabled={!canSocial}
              onClick={() =>
                downloadJson(`${filePrefix}-social-events.json`, socialData)
              }
            />
            <ToolbarButton
              label="Export combined"
              disabled={!canCombined}
              onClick={() =>
                downloadJson(`${filePrefix}-internal-combined.json`, combinedData)
              }
            />
          </div>
          {sections.map((s) => (
            <RawJsonPanel
              key={s.id}
              label={s.label}
              source={s.source}
              recordLabel={s.recordLabel}
              dataTier={s.dataTier}
              data={s.data}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
