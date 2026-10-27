import type { ViewportCell } from "./terminalViewport.ts";

/**
 * What the tools over a pane's grid (TerminalViewportTools) read of it: where the grid is drawn,
 * its size, the cells of the screen the bridge last synced, and word when either changes.
 */
export interface TerminalScreen {
  /** the grid's box on the page */
  readonly element: HTMLElement;
  readonly cols: number;
  readonly rows: number;
  /** one cell, in CSS pixels: the grid starts at the element's corner */
  cellSize(): { width: number; height: number };
  /** a cell of the screen; a wide character's second column has width 0 */
  cell(row: number, col: number): ViewportCell | undefined;
  /** new output was drawn */
  onOutput(listener: () => void): () => void;
  /** the grid changed its size */
  onResize(listener: () => void): () => void;
}
