import { REPLACEMENT_COMPOSITION } from "./replacementIme.ts";

/** Restty clears its editor before reading an empty compositionend.data, and sends commits
 * synchronously. Read the corrected DOM first and defer commits one task so pane reset can cancel
 * them. A following key drains commits first; overlapping compositions keep their own text. */
export function nativeIme(element: HTMLElement, field: HTMLTextAreaElement, send: (data: string) => void) {
  let active = false;
  let ending = false;
  let preeditLength = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending: string[] = [];
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const text of pending.splice(0)) send(text);
  };
  const reset = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending.length = 0;
    active = false;
    ending = false;
  };
  const start = (event: CompositionEvent): void => {
    if (!(REPLACEMENT_COMPOSITION in event)) { active = true; preeditLength = 0; }
  };
  const update = (event: CompositionEvent): void => {
    if (!(REPLACEMENT_COMPOSITION in event)) preeditLength = event.data?.length ?? 0;
  };
  const end = (event: CompositionEvent): void => {
    if (REPLACEMENT_COMPOSITION in event) return;
    if (!active) {
      event.stopImmediatePropagation();
      return;
    }
    active = false;
    ending = true;
    const text = (preeditLength > 0 ? field.value.slice(-preeditLength) : field.value) || event.data || "";
    Object.defineProperty(event, "data", { configurable: true, value: text });
  };
  const ended = (): void => { ending = false; };
  const key = (event: KeyboardEvent): void => {
    if (event.type === "keydown" && !event.isComposing && event.keyCode !== 229 && !active) flush();
  };
  element.addEventListener("compositionstart", start, true);
  element.addEventListener("compositionupdate", update, true);
  element.addEventListener("compositionend", end, true);
  element.addEventListener("compositionend", ended);
  element.addEventListener("keydown", key, true);
  return {
    input(data: string): boolean {
      if (!ending) { flush(); return true; }
      pending.push(data);
      timer ??= setTimeout(flush, 0);
      return false;
    },
    reset,
    dispose(): void {
      reset();
      element.removeEventListener("compositionstart", start, true);
      element.removeEventListener("compositionupdate", update, true);
      element.removeEventListener("compositionend", end, true);
      element.removeEventListener("compositionend", ended);
      element.removeEventListener("keydown", key, true);
    },
  };
}
