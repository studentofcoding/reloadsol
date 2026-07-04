import type { RawSection } from "@/strategies/token-locate";

export type InternalExportMeta = {
  tokenAddress: string;
  exportedAt: string;
};

export type CombinedInternalExport = {
  tokenAddress: string;
  exportedAt: string;
  mcapTracker: unknown | null;
  socialEvents: unknown | null;
};

export function findSectionData(
  sections: RawSection[],
  id: string,
): unknown | null {
  const section = sections.find((s) => s.id === id);
  if (!section?.data) return null;
  if (Array.isArray(section.data) && section.data.length === 0) return null;
  return section.data;
}

export function buildMcapExportPayload(
  _meta: InternalExportMeta,
  sections: RawSection[],
): unknown | null {
  return findSectionData(sections, "mcap-tracking");
}

export function buildSocialExportPayload(
  _meta: InternalExportMeta,
  sections: RawSection[],
): unknown | null {
  return findSectionData(sections, "social-events");
}

export function buildCombinedInternalExport(
  meta: InternalExportMeta,
  sections: RawSection[],
): CombinedInternalExport {
  return {
    tokenAddress: meta.tokenAddress,
    exportedAt: meta.exportedAt,
    mcapTracker: buildMcapExportPayload(meta, sections),
    socialEvents: buildSocialExportPayload(meta, sections),
  };
}

export function shortMintFilename(tokenAddress: string): string {
  if (tokenAddress.length <= 12) return tokenAddress;
  return `${tokenAddress.slice(0, 6)}-${tokenAddress.slice(-6)}`;
}

export function copyJson(data: unknown): void {
  void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function hasExportableData(data: unknown | null): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === "object") return Object.keys(data as object).length > 0;
  return true;
}

export function hasCombinedExportableData(sections: RawSection[]): boolean {
  const combined = buildCombinedInternalExport(
    { tokenAddress: "", exportedAt: "" },
    sections,
  );
  return (
    hasExportableData(combined.mcapTracker) ||
    hasExportableData(combined.socialEvents)
  );
}
