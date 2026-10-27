/** The links a terminal draws: web addresses, opened in a new tab, and nothing else. */

/**
 * A URI this app opens in a new tab: an http(s) address and nothing else. The terminal draws an
 * OSC 8 link only when this says so (the synced screen's drawing, shared/ssp-display.ts, writes
 * any other as plain text), so a line crafted to look like a link cannot hand the browser a
 * scheme of its own choosing (`javascript:`, `data:`, an OS handler).
 */
export function isWebLink(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/**
 * Opens an http(s) address in a new tab: a link's own click, with no opener
 * and no referrer. window.open with a features string (even "noopener") opens a popup window instead.
 */
export function openWebLink(uri: string): void {
  const link = document.createElement("a");
  link.href = uri;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
}

/** A web address in a row's text, ending before the punctuation that closes the sentence around it. */
const WEB_ADDRESS = /https?:\/\/[^\s"'<>`]+?(?=[.,;:!?)\]}'"]*(?:[\s"'<>`]|$))/gi;

/**
 * The web address a cell of a row is part of, or null: `cells` holds each column's text (a wide
 * character's second column is ""). An address printed as plain text is a link, as a terminal shows it.
 */
export function webLinkAt(cells: readonly string[], col: number): string | null {
  // one character per column, so a match's index is a column; anything an address cannot hold is a blank
  const row = cells.map((text) => (text.length === 1 && text.charCodeAt(0) < 0x7f ? text : " ")).join("");
  for (const match of row.matchAll(WEB_ADDRESS)) {
    if (col >= match.index && col < match.index + match[0].length) return match[0];
  }
  return null;
}

/** The local path a file URI names (Markdown reads file links with it), or null. */
export function fileUriPath(uri: string): string | null {
  // a control character belongs to no path, and URL drops a trailing one before it can be seen
  if (!/^file:\/\/\//i.test(uri) || /[\u0000-\u001f\u007f]/.test(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.host || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    // two separators in front name a network share on a Windows PC, however the second was written
    if (/[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) return null;
    // `/C:/Users/me/a.md` is how a URI writes a Windows drive path
    return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
  } catch {
    return null; // malformed URI input is not a file link
  }
}
