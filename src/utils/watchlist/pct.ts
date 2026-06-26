export function pctFromBaseline(
  initial: number | null | undefined,
  current: number | null | undefined,
): number | null {
  if (initial == null || initial <= 0 || current == null || current <= 0) {
    return null;
  }
  return ((current - initial) / initial) * 100;
}
