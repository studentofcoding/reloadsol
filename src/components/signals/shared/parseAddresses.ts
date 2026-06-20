/** Parse comma- or pipe-separated token addresses from URL query params. */
export function parseAddresses(param: string | null): string[] {
  if (!param) return [];
  return param
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build Signals Board deep link with optional address list. */
export function boardTabUrl(addresses?: string[]): string {
  if (!addresses?.length) {
    return "/dev/signals?tab=board";
  }
  return `/dev/signals?tab=board&addresses=${encodeURIComponent(addresses.join(","))}`;
}
