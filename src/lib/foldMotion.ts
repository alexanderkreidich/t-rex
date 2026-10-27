/**
 * The sidebar's folds in motion: a workspace's tab rows, and a repository's worktrees, slide up
 * under the row they hang from while the rows below rise with them, and slide back down the same
 * way. Transform and opacity only (FLIP): React changes the layout once, and each row is drawn
 * from where it was to where it now sits.
 *
 * A block that folds (`[data-fold]`, hidden by React) stays drawn out of the flow until its slide
 * ends, clipped at its own top edge, so the rows below rise as it goes; its `hidden` stays React's.
 * A second fold mid-flight starts from wherever things are drawn: `captureFold` reads the drawn
 * places, transforms included, before React renders, and `playFold` moves everything on from there.
 */

/** the rows that move: as the tab row drag's (lib/useTabRowDrag.ts), never one inside another */
const ROWS = ".workspace-header, .workspace-tab, .sidebar-inline-error, .sidebar-pinned-label";
const BLOCKS = "[data-fold]";

export type FoldMotion = "slide" | "fade" | "none";

export interface FoldCapture {
  rows: Map<HTMLElement, number>;
  blocks: Map<HTMLElement, { opacity: number; width: number; display: string; folding: string | undefined }>;
}

const playing = new WeakMap<HTMLElement, Animation[]>();

/** Where every shown row and fold block is drawn now, mid-flight included. */
export function captureFold(root: HTMLElement): FoldCapture {
  const rows = new Map<HTMLElement, number>();
  for (const row of root.querySelectorAll<HTMLElement>(ROWS)) {
    if (row.getClientRects().length > 0) rows.set(row, row.getBoundingClientRect().top);
  }
  const blocks: FoldCapture["blocks"] = new Map();
  for (const block of root.querySelectorAll<HTMLElement>(BLOCKS)) {
    if (block.getClientRects().length === 0) continue;
    const style = getComputedStyle(block);
    blocks.set(block, { opacity: Number(style.opacity), width: block.getBoundingClientRect().width, display: style.display, folding: block.dataset["folding"] });
  }
  return { rows, blocks };
}

const FOLDING_STYLE = ["display", "position", "top", "width", "clip-path", "pointer-events"];

/** a block hidden by React but still drawn, in the flow for now, until its slide ends */
function drawHidden(block: HTMLElement, display: string, folding: "out" | "held"): void {
  settle(block);
  block.dataset["folding"] = folding;
  block.style.setProperty("display", display, "important");
  if (folding === "out") block.style.setProperty("pointer-events", "none");
}

interface Run { height: number }

/**
 * Where folding blocks are drawn while they slide. One folding away leaves the flow, so the rows
 * below rise as it goes, at the place and width it had under the row it hangs from (a flex row
 * would put it at its own top). Blocks side by side (a group's folded worktrees) slide as one
 * sheet: each stands under the one before it, and every one clips its rows at the run's top edge,
 * the bottom of the row they hang from.
 */
function stack(moving: HTMLElement[], widths: Map<HTMLElement, number>): Map<HTMLElement, Run> {
  const runs = new Map<HTMLElement, Run>();
  for (const block of moving) {
    const previous = block.previousElementSibling;
    const run = previous instanceof HTMLElement && runs.get(previous) || { height: 0 };
    if (block.dataset["folding"] === "out") {
      // still in the flow: where it stands, under the ones before it in its run, which have left it
      const top = block.getBoundingClientRect().top + run.height;
      block.style.setProperty("position", "absolute", "important");
      block.style.setProperty("width", `${widths.get(block) ?? 0}px`);
      const box = block.offsetParent instanceof HTMLElement ? block.offsetParent : null;
      const origin = box ? box.getBoundingClientRect().top + box.clientTop - box.scrollTop : 0;
      block.style.setProperty("top", `${top - origin}px`);
    }
    block.style.setProperty("clip-path", `inset(${-run.height}px 0 0 0)`);
    run.height += block.offsetHeight;
    runs.set(block, run);
  }
  return runs;
}

function settle(block: HTMLElement): void {
  delete block.dataset["folding"];
  for (const property of FOLDING_STYLE) block.style.removeProperty(property);
}

/**
 * Run after React has committed a fold (a layout effect): `slide` moves the rows, `fade` (reduced
 * motion) only fades a block in, `none` (the keyboard) changes everything at once.
 */
export function playFold(root: HTMLElement, capture: FoldCapture, motion: FoldMotion): void {
  for (const animation of playing.get(root) ?? []) animation.cancel();
  playing.delete(root);
  const blocks = [...root.querySelectorAll<HTMLElement>(BLOCKS)];
  if (motion !== "slide") {
    for (const block of blocks) if (block.dataset["folding"]) settle(block);
    if (motion === "fade") {
      const fading = blocks.filter((block) => !capture.blocks.has(block) && block.getClientRects().length > 0)
        .map((block) => block.animate({ opacity: [0, 1] }, timing(root)));
      if (fading.length > 0) playing.set(root, fading);
    }
    return;
  }

  // a block React just hid stays drawn, the outermost one sliding out of the flow and any inside it
  // held as it was; one shown again, or caught mid-slide, comes (back) in
  const leaving: HTMLElement[] = [];
  const entering: HTMLElement[] = [];
  for (const block of blocks) {
    const before = capture.blocks.get(block);
    const within = (outer: HTMLElement) => outer.contains(block);
    if (block.hidden) {
      if (!before) { if (block.dataset["folding"]) settle(block); continue; }
      if (leaving.some(within)) { drawHidden(block, before.display, "held"); continue; }
      drawHidden(block, before.display, "out");
      leaving.push(block);
    } else if ((!before || before.folding !== undefined) && !leaving.some(within) && !entering.some(within)) {
      settle(block);
      block.dataset["folding"] = "in";
      entering.push(block);
    } else if (block.dataset["folding"]) {
      settle(block);
    }
  }

  const widths = new Map(leaving.map((block) => [block, capture.blocks.get(block)!.width]));
  const runs = new Map([...stack(leaving, widths), ...stack(entering, widths)]);

  const options = timing(root);
  const animations: Animation[] = [];
  for (const row of root.querySelectorAll<HTMLElement>(ROWS)) {
    if (row.getClientRects().length === 0) continue;
    const top = row.getBoundingClientRect().top;
    const out = leaving.find((block) => block.contains(row));
    const into = out ? undefined : entering.find((block) => block.contains(row));
    const drawn = capture.rows.get(row);
    const block = out ?? into;
    const height = block ? runs.get(block)?.height ?? 0 : 0;
    const from = drawn !== undefined ? drawn - top : into ? -height : 0;
    const to = out ? -height : 0;
    if (Math.abs(from - to) < 0.5) continue;
    animations.push(row.animate({ transform: [`translateY(${from}px)`, `translateY(${to}px)`] }, { ...options, fill: out ? "forwards" : "none" }));
  }
  for (const block of leaving) animations.push(block.animate({ opacity: [capture.blocks.get(block)!.opacity, 0] }, { ...options, fill: "forwards" }));
  for (const block of entering) animations.push(block.animate({ opacity: [capture.blocks.get(block)?.opacity ?? 0, 1] }, options));
  if (animations.length === 0) {
    for (const block of [...leaving, ...entering]) settle(block);
    return;
  }
  playing.set(root, animations);
  // cut short by the next fold, it is that one's to finish
  void Promise.all(animations.map((animation) => animation.finished)).then(() => {
    for (const block of root.querySelectorAll<HTMLElement>(BLOCKS)) if (block.dataset["folding"]) settle(block);
    for (const animation of animations) animation.cancel();
    if (playing.get(root) === animations) playing.delete(root);
  }, () => {});
}

/** the fold's clock and curve, from styles.css */
function timing(root: HTMLElement): KeyframeAnimationOptions {
  const style = getComputedStyle(root);
  return { duration: milliseconds(style.getPropertyValue("--dur-fold")), easing: style.getPropertyValue("--ease-spring").trim() || "ease-out" };
}

/** a CSS time in milliseconds: the build writes `420ms` as `.42s` */
export function milliseconds(time: string): number {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(time);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value * (match[2] === "s" ? 1000 : 1) : 0;
}
