
/** Lines kept visible between pages, in chat and in terminal history. */
export const PAGE_OVERLAP_ROWS = 1;

/** Native rows and chat pixels retain the requested overlap between pages. */
export function pageScrollDistance(viewport: number, lineHeight: number, overlapRows: number): number {
  return Math.max(1, viewport - lineHeight * overlapRows);
}
