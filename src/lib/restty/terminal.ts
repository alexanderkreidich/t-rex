/**
 * One pane's terminal on restty (libghostty-vt in WASM, WebGPU with a WebGL2 fallback): the
 * renderer PaneTerminal writes the pane's screen into, and the source of what the user types.
 *
 * restty here is a terminal without a pty of its own. Output is what the SSP view (lib/ssp) or a
 * read-only stream writes; input is everything restty would send a pty (keys encoded in the
 * mode the screen asked for, a paste, IME text, mouse and focus reports), handed to `onData`.
 * The grid is the app's to size: restty measures cells and fits the canvas only when asked.
 */
import { createResttyRuntime, type ResttyFontInput, type ResttyRuntime } from "restty/internal/runtime";
import type { GhosttyTheme, PtyCallbacks, PtyTransport } from "restty";
import { fallbackFonts, loadFallbacks, missingFallbacks, onFallbacks } from "./fonts.ts";
import { resttySession } from "./session.ts";
import { replacementIme } from "./replacementIme.ts";
import { nativeIme } from "./nativeIme.ts";

export type TerminalRenderer = "auto" | "webgpu" | "webgl2";

export interface ResttyTerminalOptions {
  fontSize: number;
  /** the font list (lib/restty/fonts.ts), which the fallbacks loaded so far follow; `fontKey` names it for the cell-size cache */
  fonts: Promise<ResttyFontInput[]>;
  fontKey: string;
  theme: GhosttyTheme;
  ligatures: boolean;
  renderer: TerminalRenderer;
  /** what the size measures: the em (the app's setting, as in Ghostty), or the whole line (restty's playground) */
  fontSizeMode?: "em" | "height";
  /** what the terminal sends the program: typed keys, a paste, IME text, mouse and focus reports */
  onData(data: string): void;
  /** a key event before restty encodes it; false keeps it from restty (the app handled it) */
  onKey?(event: KeyboardEvent): boolean;
}

/** A cell in device pixels, as restty measures it, and the font size in device pixels it was measured at. */
interface CellMetrics { readonly cellW: number; readonly cellH: number; readonly fontSizePx: number }

/** Cell sizes restty measured, per font list, size and pixel ratio: a new terminal sizes its grid before its fonts load. */
const measured = new Map<string, CellMetrics>();
const metricsKey = (fontKey: string, fontSize: number, dpr: number): string => `${fontKey}\u0000${fontSize}\u0000${dpr}`;

/** JetBrains Mono's cell before anything was measured: 600 units wide, 1320 tall, on a 1000-unit em. */
function estimatedMetrics(fontSize: number, dpr: number): CellMetrics {
  const fontSizePx = Math.max(1, Math.round(fontSize * dpr));
  return { cellW: Math.max(1, Math.round(fontSizePx * 0.6)), cellH: Math.max(1, Math.round(fontSizePx * 1.32)), fontSizePx };
}

const dpr = (): number => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

/**
 * WebGPU canvases closed terminals drew on, for the next terminals to draw on. WebKit never gives
 * back a WebGPU canvas's swapchain (three buffers the canvas's size, ~30 MB for a pane on a Retina
 * screen): not when its context is unconfigured, its device destroyed or the canvas collected. A
 * new canvas per terminal grew the Mac app's page by that much on every switch to a tab not kept
 * mounted; a reused canvas keeps the buffers it has. The list is never longer than the most
 * terminals open at once.
 */
const spareCanvases: HTMLCanvasElement[] = [];

export class ResttyTerminal {
  /** the terminal's box: the canvas and the IME field restty types from */
  readonly element: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  /** typing reaches nothing while set (observing, a held or ended pane): keys, pastes and reports alike */
  inputDisabled = false;
  private runtime: ResttyRuntime | null = null;
  private readonly replacement: ReturnType<typeof replacementIme>;
  private readonly composition: ReturnType<typeof nativeIme>;
  /** restty's side of the "pty": output goes in through it */
  private connection: PtyCallbacks | null = null;
  private lifecycleReady = false;
  /** output written before the connection: it goes in, in order, once there is one */
  private readonly pending: string[] = [];
  private gridCols: number;
  private gridRows: number;
  private fontSize: number;
  private theme: GhosttyTheme;
  private ligatures: boolean;
  private renderer: TerminalRenderer;
  /** drawn while shown (setDrawing) */
  private drawing = true;
  private fontKey: string;
  private readonly fontSizeMode: "em" | "height";
  private fixed: { cols: number; rows: number } | null = null;
  private isReady = false;
  private disposed = false;
  private readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  private readonly readyListeners = new Set<() => void>();
  private readonly onData: (data: string) => void;
  private readonly onKeyEvent: (event: KeyboardEvent) => void;
  private readonly createdAt = performance.now();
  /** the font list before the fallbacks, as last set */
  private fonts: ResttyFontInput[] = [];
  /** the fallbacks the runtime draws with: a newer set than this means the list is set again */
  private fallbacksDrawn = 0;
  private readonly offFallbacks: () => void;

  constructor(parent: HTMLElement, options: ResttyTerminalOptions) {
    this.fontSize = options.fontSize;
    this.theme = options.theme;
    this.ligatures = options.ligatures;
    this.renderer = options.renderer;
    this.fontKey = options.fontKey;
    this.fontSizeMode = options.fontSizeMode ?? "em";
    this.onData = options.onData;
    const doc = parent.ownerDocument;
    this.element = doc.createElement("div");
    this.element.className = "restty-terminal";
    // a spare canvas holds a WebGPU context: a terminal set to WebGL2 takes a new one
    const canvas = (options.renderer === "webgl2" ? undefined : spareCanvases.pop()) ?? doc.createElement("canvas");
    // restty swaps the canvas for a new one when it falls back from WebGPU: it keeps the class only
    canvas.className = "restty-terminal-canvas";
    canvas.tabIndex = 0;
    this.textarea = doc.createElement("textarea");
    this.textarea.className = "terminal-ime";
    this.textarea.tabIndex = -1;
    this.textarea.autocapitalize = "off";
    this.textarea.autocomplete = "off";
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.spellcheck = false;
    this.textarea.setAttribute("aria-hidden", "true");
    this.element.append(canvas, this.textarea);
    parent.append(this.element);
    this.replacement = replacementIme(this.element, this.textarea);
    this.composition = nativeIme(this.element, this.textarea, (data) => {
      if (!this.disposed && !this.inputDisabled) this.onData(data);
    });
    this.paintBackground();
    const estimate = this.proposeGrid(this.fontSize);
    this.gridCols = estimate?.cols ?? 80;
    this.gridRows = estimate?.rows ?? 24;

    // restty's own key listener is on the window: the app's hook runs on the way there, and an event
    // it took never reaches restty
    this.onKeyEvent = (event) => {
      if (options.onKey && !options.onKey(event)) event.stopPropagation();
    };
    this.element.addEventListener("keydown", this.onKeyEvent);
    this.element.addEventListener("keyup", this.onKeyEvent);

    void options.fonts.then((fonts) => {
      if (this.disposed) return;
      this.fonts = fonts;
      this.start(canvas, this.withFallbacks());
    });
    // a fallback another terminal (or this one) asked for has arrived: this one draws with it too
    this.offFallbacks = onFallbacks(() => {
      if (this.runtime && fallbackFonts().length !== this.fallbacksDrawn) void this.runtime.terminal.setFonts(this.withFallbacks());
    });
  }

  private start(canvas: HTMLCanvasElement, fonts: ResttyFontInput[]): void {
    // restty's pty path is the one that reads output as a terminal must: it tracks the modes the
    // screen sets (mouse reporting, bracketed paste, focus events) and holds synchronized output.
    // This "pty" connects as soon as restty is up, and its output is what write() is given.
    const transport: PtyTransport = {
      connect: ({ callbacks }) => {
        this.connection = callbacks;
        callbacks.onConnect?.();
        for (const data of this.pending.splice(0)) callbacks.onData?.(data);
        this.becomeReady();
      },
      disconnect: () => { this.connection = null; },
      // what restty would send a pty: keys, a paste, IME text and the reports it makes itself
      sendInput: (data) => {
        this.input(data);
        return true;
      },
      // restty measured the grid (a fit, a font, a resize): the cells are what the grid is drawn in
      resize: (cols, rows, meta) => {
        if (meta?.cellW && meta.cellH) {
          const fontSizePx = Math.max(1, Math.round(this.fontSize * dpr()));
          measured.set(metricsKey(this.fontKey, this.fontSize, dpr()), { cellW: meta.cellW, cellH: meta.cellH, fontSizePx });
        }
        this.setGrid(cols, rows);
        return true;
      },
      isConnected: () => this.connection !== null,
    };
    const runtime = createResttyRuntime({
      mount: { canvas, imeInput: this.textarea, session: resttySession() },
      terminal: {
        renderer: this.renderer,
        fontSize: this.fontSize,
        // the size is the em, as in Ghostty and every font setting: restty's default sizes the whole line
        fontSizeMode: this.fontSizeMode,
        ligatures: this.ligatures,
        fonts,
        theme: this.theme,
        // the grid is sized by the app (PaneTerminal fits once a resize settles), never by restty itself
        autoResize: false,
        showResizeOverlay: false,
        // replies to the program's queries come from herdr: one from here would reach it as typing
        forwardTerminalReplies: false,
        // herdr owns the history: the terminal holds the screen and nothing scrolled off it
        maxScrollbackBytes: 0,
        // a drag on a touch screen scrolls herdr's history (PaneTerminal turns it into wheel reports)
        touchSelectionMode: "off",
        alphaBlending: "linear-corrected",
      },
      services: { ptyTransport: transport },
    });
    this.runtime = runtime;
    if (!this.drawing) runtime.terminal.setPaused(true);
    runtime.events.subscribe((event) => {
      if (event.type !== "state" || event.state !== "ready") return;
      this.lifecycleReady = true;
      this.becomeReady();
    });
    void runtime.lifecycle.init().catch(() => undefined);
    // once restty is up (the init above), it calls connect above; asked before init, it would start
    // an init of its own that the one above supersedes, and never connect
    runtime.io.connectPty("");
  }

  /** Up and connected: the grid is measured and output draws. */
  private becomeReady(): void {
    if (this.isReady || this.disposed || !this.lifecycleReady || !this.connection || !this.runtime) return;
    this.isReady = true;
    this.element.dataset.ready = "true";
    // how long a terminal takes to come up, for the browser's performance tools (and the PR's numbers)
    performance.mark("restty:ready", { detail: { since: performance.now() - this.createdAt, backend: this.runtime.render.getBackend() } });
    // a grid set before the runtime could draw it (an adopted one) is applied now
    if (this.fixed) this.applyFixed(this.fixed.cols, this.fixed.rows);
    for (const listener of [...this.readyListeners]) listener();
  }

  get cols(): number { return this.gridCols; }
  get rows(): number { return this.gridRows; }
  /** restty has drawn its first frame's worth: fonts loaded, grid measured, renderer up */
  get ready(): boolean { return this.isReady; }
  get canvas(): HTMLCanvasElement | null { return this.element.querySelector("canvas"); }
  /** the renderer restty runs on: webgpu or webgl2, "" before it is up */
  get backend(): string { return this.runtime?.render.getBackend() ?? ""; }

  /** Data as if the user typed it (the key bar, a chord): it goes where restty's own input goes. */
  input(data: string): void {
    if (!this.disposed && !this.inputDisabled && data) {
      this.replacement.flush();
      if (this.composition.input(data)) this.onData(data);
    }
  }

  /** Pastes text as a paste from the clipboard is: bracketed when the screen asked for it, line breaks as Enter. */
  paste(text: string): void {
    if (this.disposed || !text) return;
    const data = new DataTransfer();
    data.setData("text/plain", text);
    // restty's own paste handling on its field, which knows the modes the screen set
    this.textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }

  /** The program reads the mouse (the screen asked for reporting): restty turns presses and the wheel into its reports. */
  mouseReporting(): boolean {
    return this.runtime?.interaction.getMouseStatus().active ?? false;
  }

  /** The font list with the fallbacks loaded so far after it. */
  private withFallbacks(): ResttyFontInput[] {
    const fallbacks = fallbackFonts();
    this.fallbacksDrawn = fallbacks.length;
    return [...this.fonts, ...fallbacks];
  }

  /** VT output for the screen: the SSP view's drawing, or a read-only stream. */
  write(data: string): void {
    if (!data || this.disposed) return;
    // text the bundled faces may lack (symbols, emoji, CJK) brings its fallback in
    const missing = missingFallbacks(data);
    if (missing.length > 0) loadFallbacks(missing);
    if (this.connection) this.connection.onData?.(data);
    else this.pending.push(data);
  }

  /** A full reset (RIS); the colours are the app's again, since a reset puts the terminal's own back. */
  reset(): void {
    this.composition.reset();
    this.replacement.reset();
    this.write("\x1bc");
    this.runtime?.terminal.resetTheme();
    this.runtime?.terminal.applyTheme(this.theme, "app");
  }

  /**
   * Sizes the grid to the mount: false while the cell is not known yet (no font loaded) or the mount
   * has no size. The box keeps that size until the next fit, so a mount that changes meanwhile
   * clips or uncovers cells and never stretches the canvas.
   */
  fit(): boolean {
    if (this.disposed) return false;
    const box = this.element.parentElement;
    const width = box?.clientWidth ?? 0;
    const height = box?.clientHeight ?? 0;
    if (width <= 0 || height <= 0) return false;
    this.fixed = null;
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    if (!this.runtime || !this.isReady) {
      const estimate = this.proposeGrid(this.fontSize);
      if (estimate) this.setGrid(estimate.cols, estimate.rows);
      return false;
    }
    this.runtime.interaction.updateSize(true);
    return true;
  }

  /**
   * A grid that is not this box's own (an observer's, a mirrored pane's): drawn at its size,
   * which may overflow the box (PaneTerminal scrolls it).
   */
  resize(cols: number, rows: number): void {
    if (this.disposed || cols <= 0 || rows <= 0) return;
    this.fixed = { cols, rows };
    if (this.runtime && this.isReady) this.applyFixed(cols, rows);
    else this.setGrid(cols, rows);
  }

  private applyFixed(cols: number, rows: number): void {
    const metrics = this.metrics(this.fontSize);
    if (metrics) {
      const ratio = dpr();
      this.element.style.width = `${(cols * metrics.cellW) / ratio}px`;
      this.element.style.height = `${(rows * metrics.cellH) / ratio}px`;
    }
    this.runtime?.interaction.resize(cols, rows);
    this.setGrid(cols, rows);
  }

  /** The grid the box holds at a font size, from the measured (or estimated) cell; null before layout. */
  proposeGrid(fontSize: number): { cols: number; rows: number } | null {
    const box = this.element.parentElement ?? this.element;
    const width = box.clientWidth;
    const height = box.clientHeight;
    if (width <= 0 || height <= 0) return null;
    const metrics = this.metrics(fontSize);
    if (!metrics) return null;
    const ratio = dpr();
    return {
      cols: Math.max(1, Math.floor(Math.floor(width * ratio) / metrics.cellW)),
      rows: Math.max(1, Math.floor(Math.floor(height * ratio) / metrics.cellH)),
    };
  }

  /** The cell at a size: measured there, scaled from another measured size, or JetBrains Mono's. */
  private metrics(fontSize: number): CellMetrics | null {
    const ratio = dpr();
    const exact = measured.get(metricsKey(this.fontKey, fontSize, ratio));
    if (exact) return exact;
    const other = measured.get(metricsKey(this.fontKey, this.fontSize, ratio));
    const fontSizePx = Math.max(1, Math.round(fontSize * ratio));
    if (other) {
      // restty rounds the cell from the font's advance at the size in device pixels: scale that
      return {
        cellW: Math.max(1, Math.round((other.cellW / other.fontSizePx) * fontSizePx)),
        cellH: Math.max(1, Math.round((other.cellH / other.fontSizePx) * fontSizePx)),
        fontSizePx,
      };
    }
    return estimatedMetrics(fontSize, ratio);
  }

  /** One cell on screen, in CSS pixels. */
  cellSize(): { width: number; height: number } {
    const metrics = this.metrics(this.fontSize)!;
    const ratio = dpr();
    return { width: metrics.cellW / ratio, height: metrics.cellH / ratio };
  }

  setFontSize(size: number): void {
    if (size === this.fontSize || this.disposed) return;
    this.fontSize = size;
    this.runtime?.terminal.setFontSize(size);
  }

  get currentFontSize(): number { return this.fontSize; }

  /** A new font list: the grid is measured again once it loaded (onResize says if it moved). */
  setFonts(fonts: ResttyFontInput[], fontKey: string): Promise<void> {
    this.fontKey = fontKey;
    this.fonts = fonts;
    return this.runtime?.terminal.setFonts(this.withFallbacks()) ?? Promise.resolve();
  }

  setTheme(theme: GhosttyTheme): void {
    this.theme = theme;
    this.paintBackground();
    // a palette entry a theme leaves out keeps the last one set: start from the terminal's own
    this.runtime?.terminal.resetTheme();
    this.runtime?.terminal.applyTheme(theme, "app");
  }

  setLigatures(enabled: boolean): void {
    this.ligatures = enabled;
    this.runtime?.terminal.setLigatures(enabled);
  }

  setRenderer(renderer: TerminalRenderer): void {
    if (renderer === this.renderer) return;
    this.renderer = renderer;
    this.runtime?.terminal.setRenderer(renderer);
  }

  /**
   * Draws only while shown: a pane hidden in a cached tab, or behind the other half of its split,
   * still takes its output and draws it once it is shown again. Idle, restty draws nothing anyway;
   * this spares the frames a hidden pane's output would cost.
   */
  setDrawing(drawing: boolean): void {
    if (drawing === this.drawing) return;
    this.drawing = drawing;
    this.runtime?.terminal.setPaused(!drawing);
  }

  focus(): void {
    if (this.disposed) return;
    if (this.runtime) this.runtime.interaction.focus();
    else this.textarea.focus({ preventScroll: true });
  }

  blur(): void {
    this.runtime?.interaction.blur();
    if (this.element.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  /** Selects the word at a point on the page, as restty's own double click does; false where there is none. */
  selectWordAt(clientX: number, clientY: number): boolean {
    return this.runtime?.interaction.selectWordAtClientPoint(clientX, clientY) ?? false;
  }

  onResize(listener: (cols: number, rows: number) => void): () => void {
    this.resizeListeners.add(listener);
    return () => { this.resizeListeners.delete(listener); };
  }

  onReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => { this.readyListeners.delete(listener); };
  }

  private setGrid(cols: number, rows: number): void {
    if (cols === this.gridCols && rows === this.gridRows) return;
    this.gridCols = cols;
    this.gridRows = rows;
    for (const listener of [...this.resizeListeners]) listener(cols, rows);
  }

  /** The box shows the theme's background until the first frame covers it. */
  private paintBackground(): void {
    const bg = this.theme.colors.background;
    this.element.style.backgroundColor = bg ? `rgb(${bg.r}, ${bg.g}, ${bg.b})` : "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.composition.dispose();
    this.replacement.dispose();
    this.offFallbacks();
    this.element.removeEventListener("keydown", this.onKeyEvent);
    this.element.removeEventListener("keyup", this.onKeyEvent);
    this.resizeListeners.clear();
    this.readyListeners.clear();
    // the canvas goes to the next terminal unless it holds a WebGL2 context (one that never started holds none)
    const spare = !this.runtime || this.backend === "webgpu" ? this.canvas : null;
    this.runtime?.lifecycle.destroy();
    this.runtime = null;
    this.element.remove();
    if (spare) {
      spare.remove();
      spare.removeAttribute("style");
      // a new size drops the last frame drawn
      spare.width = 1;
      spare.height = 1;
      spareCanvases.push(spare);
    }
  }
}
