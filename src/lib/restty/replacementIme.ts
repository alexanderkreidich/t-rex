import { keyboardNeedsText } from "../deleteRepeat.ts";

export const REPLACEMENT_COMPOSITION = Symbol("replacement-composition");

const HANGUL = /^[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]+$/u;

/** Safari's Korean editor replaces syllables without composition events. Give restty the
 * equivalent composition, keeping provisional text local until a commit key, paste or blur. */
export function replacementIme(element: HTMLElement, field: HTMLTextAreaElement, enabled =
  /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Android/.test(navigator.userAgent)
  && (/Mac/.test(navigator.platform) || keyboardNeedsText(navigator))): { flush(): void; reset(): void; dispose(): void } {
  let active = false;
  let start = 0;
  let deleting = false;
  let text = "";
  let keydownSeen = false;
  let editedBeforeKey = false;
  const synthetic = new WeakSet<Event>();
  const composition = (type: string, data: string): void => {
    const event = new CompositionEvent(type, { data, bubbles: true });
    Object.defineProperty(event, REPLACEMENT_COMPOSITION, { value: true });
    synthetic.add(event);
    field.dispatchEvent(event);
  };
  // These events teach restty its preedit, not the app's native-composition gate: a key-bar
  // action must still be able to commit a replacement, just like a hardware commit key.
  const isolate = (event: Event): void => { if (synthetic.has(event)) event.stopPropagation(); };
  const finish = (commit: boolean): void => {
    if (!active) return;
    active = false;
    deleting = false;
    const committed = commit ? text : "";
    text = "";
    field.value = "";
    composition("compositionend", committed);
  };
  const beforeInput = (event: InputEvent): void => {
    if (!enabled || event.isComposing) return;
    if (active && /^(deleteContentBackward|deleteContentForward|insertReplacementText)$/.test(event.inputType)) {
      deleting = event.inputType.startsWith("delete");
      event.stopImmediatePropagation();
      return;
    }
    if (event.inputType === "insertText" && event.data && HANGUL.test(event.data)) {
      if (active && !deleting) finishBeforeEdit();
      if (!active) {
        start = field.selectionStart;
        active = true;
        const value = field.value;
        const end = field.selectionEnd;
        composition("compositionstart", "");
        field.value = value;
        field.setSelectionRange(start, end);
      }
      deleting = false;
      event.stopImmediatePropagation();
    } else if (active) finishBeforeEdit();
  };
  // beforeinput's range belongs to the DOM before the commit. Safari keeps committed syllables
  // there while editing the next one; clearing it would shift the replacement's range.
  const finishBeforeEdit = (): void => {
    const value = field.value;
    const from = field.selectionStart;
    const to = field.selectionEnd;
    finish(true);
    field.value = value;
    field.setSelectionRange(from, to);
  };
  const input = (event: InputEvent): void => {
    if (!active || event.isComposing) return;
    event.stopImmediatePropagation();
    const previous = text;
    text = field.value.slice(start, field.selectionEnd);
    editedBeforeKey = !keydownSeen && text !== previous;
    if (text === "") {
      finish(false);
      return;
    }
    const value = field.value;
    const from = field.selectionStart;
    const to = field.selectionEnd;
    composition("compositionupdate", text);
    field.value = value;
    field.setSelectionRange(from, to);
  };
  const key = (event: KeyboardEvent): void => {
    if (!enabled || event.isComposing) return;
    if (event.type === "keydown") {
      keydownSeen = true;
      const edited = editedBeforeKey;
      editedBeforeKey = false;
      if (edited && !event.ctrlKey && !event.altKey && !event.metaKey && ["Backspace", "Delete"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (!event.ctrlKey && !event.altKey && !event.metaKey && HANGUL.test(event.key)) {
      event.stopPropagation();
      return;
    }
    if (!active) return;
    if (event.keyCode === 229 || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)
      || (!event.ctrlKey && !event.altKey && !event.metaKey && ["Backspace", "Delete"].includes(event.key))) {
      event.stopPropagation();
      return;
    }
    finish(true);
  };
  const keyup = (): void => { keydownSeen = false; };
  const flush = (): void => { editedBeforeKey = false; finish(true); };
  const nativeComposition = (event: Event): void => {
    if (!synthetic.has(event)) finish(true);
  };
  element.addEventListener("beforeinput", beforeInput, true);
  element.addEventListener("input", input, true);
  element.addEventListener("keydown", key, true);
  element.addEventListener("keypress", key, true);
  element.addEventListener("keyup", keyup, true);
  element.addEventListener("paste", flush, true);
  field.addEventListener("blur", flush);
  element.addEventListener("compositionstart", nativeComposition, true);
  for (const type of ["compositionstart", "compositionupdate", "compositionend"]) element.addEventListener(type, isolate);
  return {
    flush,
    reset: () => { editedBeforeKey = false; keydownSeen = false; finish(false); },
    dispose: () => {
      finish(false);
      element.removeEventListener("beforeinput", beforeInput, true);
      element.removeEventListener("input", input, true);
      element.removeEventListener("keydown", key, true);
      element.removeEventListener("keypress", key, true);
      element.removeEventListener("keyup", keyup, true);
      element.removeEventListener("paste", flush, true);
      field.removeEventListener("blur", flush);
      element.removeEventListener("compositionstart", nativeComposition, true);
      for (const type of ["compositionstart", "compositionupdate", "compositionend"]) element.removeEventListener(type, isolate);
    },
  };
}
