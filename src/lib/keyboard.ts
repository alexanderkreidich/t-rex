/*
 * Putting a phone's soft keyboard away to read the chat. iOS gives a textarea's keyboard
 * no dismiss key, so the chat offers two ways, as messaging apps do: a tap on the
 * transcript and a drag down on it. Each only blurs the field: the draft stays in the
 * composer.
 */

/** How far a finger must travel down the transcript before the keyboard goes away. */
export const DISMISS_DRAG_PX = 32;

/** lib/viewport.ts sets data-keyboard while a touch device has a text field focused. */
export function keyboardUp(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-keyboard");
}

/** Reference height for keyboard occlusion, retaining the unobstructed viewport unless the window resized. */
export function keyboardViewportReference(
  height: number,
  large: number,
  layout: number,
  remembered: { large: number; height: number } | undefined,
  keyboardActive: boolean,
): number {
  // Chrome resizes-content can shrink 100lvh along with the keyboard. With a
  // typing field (or a keyboard already up), a visual viewport filling the
  // shortened layout is not evidence that the unobstructed window resized.
  // A split view's separate visual inset still lets its new height replace it.
  const resizedWindow = remembered && large < remembered.large && height <= large && large - height <= large * 0.2
    && (!keyboardActive || height < layout);
  return Math.max(large, resizedWindow ? 0 : remembered?.height ?? 0, layout);
}

/**
 * Whether the soft keyboard holds the terminal's grid: the keyboard takes the bottom of the screen,
 * not the pane, so a fit to what is left above it would size the shared pty to that strip and
 * reflow every other viewer of the pane twice per keyboard (#1045). A host that only lost height
 * under the keyboard keeps its grid and pans; a host whose width changed (a rotation) refits even
 * under the keyboard, and a host with no keyboard over it always does. `fittedWidth` is the host's
 * width at its last fit, null before the first: that first fit waits for the keyboard to go too.
 */
export function keyboardHoldsGrid(keyboard: boolean, width: number, fittedWidth: number | null): boolean {
  return keyboard && (fittedWidth === null || width === fittedWidth);
}

