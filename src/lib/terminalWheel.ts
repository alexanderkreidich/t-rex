import { HERDR_MOUSE_SCROLL_LINES } from "./wheelSteps.ts";

/** Live settings/status read by the handler attached once for a terminal's lifetime. */
export interface TerminalWheelState {
  readonly speed: number;
  readonly omoQuestion: boolean;
}

interface WheelViewport {
  /** A selecting drag owns its wheel before any application routing. */
  readonly drag: (event: WheelEvent) => boolean;
  readonly adopted: () => boolean;
  readonly scroll: (lines: number) => void;
  /** the program reads the mouse: the terminal encodes the wheel as its reports */
  readonly reporting: () => boolean;
}

/**
 * herdr owns history; the terminal (restty, under `mount`) encodes mouse reports for applications
 * that use them. This listens on the mount ahead of the terminal, and keeps from it a wheel it
 * must not report. Returns the detach.
 */
export function attachTerminalWheel(mount: HTMLElement, state: { readonly current: TerminalWheelState }, viewport: WheelViewport): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (viewport.drag(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Observed/fixed grids pan in the browser instead of changing herdr's viewport.
    if (viewport.adopted()) {
      event.stopPropagation();
      return;
    }
    // OmO consumes wheel reports without acting while a question captures mouse input, so the
    // wheel moves herdr's history itself, as far as the reports below would: one three-line step
    // per event whatever its delta, repeated at the chosen speed for a real wheel only.
    if (state.current.omoQuestion && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY !== 0) viewport.scroll(-Math.sign(event.deltaY) * HERDR_MOUSE_SCROLL_LINES * (event.isTrusted ? state.current.speed : 1));
      return;
    }
    // A program that does not report gets nothing: the terminal has no history of its own to scroll.
    if (!viewport.reporting()) {
      event.stopPropagation();
      return;
    }
    // Trusted wheels replay at the chosen speed; touch/replays already supply their steps.
    // A trackpad pinch (Ctrl) keeps its original single-event path and all replayed modifiers.
    if (event.isTrusted && event.target && !event.ctrlKey) {
      for (let sent = 1; sent < state.current.speed; sent += 1) {
        event.target.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
          clientX: event.clientX, clientY: event.clientY,
          ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
        }));
      }
    }
  };
  mount.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => mount.removeEventListener("wheel", onWheel, { capture: true });
}
