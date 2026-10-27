import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

export const PANE_COVER_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],dialog[open]';

/** A dialog or menu over the pane covers it; a retained hidden one (a phone's sibling) covers nothing. */
export function paneCovered(): boolean {
  return [...document.querySelectorAll(PANE_COVER_SELECTOR)].some((node) =>
    !node.closest('[hidden],[inert],[aria-hidden="true"],.is-hidden')
      && node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible");
}

/** A rendered content lifetime, not merely a selected pane slot. */
export function paneContentKey(machine: Machine | undefined, pane: HerdrPane | null): string | undefined {
  return machine && pane ? JSON.stringify([machine.id, pane.pane_id, pane.terminal_id, machine.snapshot?.finish_epoch, pane.finish_id]) : undefined;
}

/** The marker lives on the successfully rendered content and disappears with its error boundary. */
export function paneContentPresented(key: string | undefined): boolean {
  if (key === undefined) return false;
  return [...document.querySelectorAll("[data-pane-content]")].some((node) =>
    node.getAttribute("data-pane-content") === key && !node.querySelector("[data-pane-content-error]"));
}
