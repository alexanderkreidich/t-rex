import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Eye, SendHorizontal, Trash2, TriangleAlert } from "lucide-react";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { MachineSession } from "../lib/machineSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { PaneCachedContext, PanePresentedContext, PaneFollowContext, PaneShownContext, PaneSubmitContext } from "../lib/paneSubmitContext.ts";
import { clipboardKey, hasModifiers, physicalKey, terminalChord, navigationSequence, keyFromData, ctrlEnterSequence, mirroredCtrlEnterKey, NO_STICKY_MODIFIERS, type StickyModifiers } from "../lib/keys.ts";
import { keyBarInputSequence, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, restoreDraft, type InputDraft } from "../lib/draft.ts";
import { composerMessage, composerPayload, submitNote } from "../lib/compose.ts";
import { AttachmentTooLargeError, assertAttachable, fetchPaneScroll, fetchPaneSelection, scrollPane } from "../lib/api.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar } from "./KeyBar.tsx";
import { TerminalInput } from "./TerminalInput.tsx";
import { FindBar } from "./FindBar.tsx";
import { TerminalViewportTools, type TerminalSearchState } from "./TerminalViewportTools.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import type { AgentStatus, ClientRole, ServerMessage } from "../../shared/protocol.ts";
import type { PaneControls } from "../lib/actions.ts";
import { useSettings, terminalTheme, type Palette, type ResolvedTheme } from "../lib/settings.ts";
import { sanitizeFontFamily } from "../lib/fontFamily.ts";
import { terminalFonts } from "../lib/restty/fonts.ts";
import { terminalColorsTheme, terminalDisplayTheme } from "../lib/restty/theme.ts";
import { ResttyTerminal } from "../lib/restty/terminal.ts";
import type { TerminalScreen } from "../lib/terminalScreen.ts";
import { useT } from "../lib/i18n.ts";
import { isAppShortcut, isBrowserZoomShortcut } from "../lib/shortcuts.ts";
import { keyboardHoldsGrid, keyboardUp } from "../lib/keyboard.ts";
import { isWebLink, openWebLink, webLinkAt } from "../lib/terminalLinks.ts";
import { keepDeleteRepeatText, keyboardNeedsText, restoreDeleteRepeatCaret } from "../lib/deleteRepeat.ts";
import { terminalLabel } from "../lib/terminalLabel.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { modalOpen } from "../lib/focus.ts";
import { pinchFontSize } from "../lib/pinchFontSize.ts";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "../lib/wheelSteps.ts";
import { attachTerminalWheel } from "../lib/terminalWheel.ts";
import { SspView } from "../lib/ssp/view.ts";
import { decodeRow } from "../../shared/ssp.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
const RESIZE_SETTLE_MS = 120;
/** How long a tab is out of use before it lets go of its pane: a glance at another window keeps it. */
const RELEASE_AFTER_MS = 1000;
/** How long typing into a pane that is opening its input waits for it, before it is held for review. */
const TYPEAHEAD_MS = 2000;

// Only a tab the user is in drives the shared grid. A window left open behind another app
// still turns visible when the screen wakes, and reconnects, reloads or moves on to the next pane
// in the background: taking the pane then sized it for nobody, and herdr's own TUI drew it cut
// off at its split's edge
const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** The PC sockets this page has been connected to (lib/machineSession.ts keeps one per PC, across pane
    views and terminal mounts): not connected on one of them, a terminal is reconnecting; on any other, it
    is connecting for the first time. The words say which (here and in the header's chip). */
const connectedSockets = new WeakSet<HerdrSocket>();

/** A failure as one line: the plain sentence, then what the server or the browser said. */
const plainError = (cause: unknown): string => {
  const failure = userErrorMessage(cause);
  return failure.detail === null ? failure.message : `${failure.message} (${failure.detail})`;
};

export interface PaneTerminalProps {
  /** App's content lifetime: the pane's content key, set while its screen is current. */
  presentationKey?: string;
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /** A restored pane keeps its ID but gets a new terminal after herdr restarts. */
  terminalId?: string | null;
  /** null while the PC identity loads, before the first attach's fixed-grid frame arrives. */
  mirrored?: boolean | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  /** the pane's own name (App's header shows it): the region around the grid announces it */
  title?: string | null;
  /** the pane's agent and its live status: an OmO question (blocked) takes the wheel and the finger */
  agent?: string | null;
  agentStatus?: AgentStatus;
  findRequest?: number;
  controls?: { current: PaneControls | null };
  /** Only the selected tile may take keyboard focus after async work or a lens change. */
  active?: boolean;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** App's count of the user's pane picks: the selected pane picked again takes the keyboard too */
  focusRequest?: number;
  /** the terminal's font size (settings) */
  terminalFontSize: number;
  /** mouse reports sent per wheel event (settings): 1 is the terminal's own one report */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in stack (settings); "" keeps the built-in one */
  terminalFontFamily: string;
  /** the resolved UI theme: the terminal's colours mirror it */
  theme: ResolvedTheme;
  /** the chrome palette (settings.ts): the terminal cursor and selection follow it */
  palette: Palette;
  /** The connection's desired role; changes are sent to the server, acks come back via onRoleAck. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  onRoleAck?: (mode: ClientRole) => void;
  /** Fires on every change of the socket's connected state (the header shows it). `connectedBefore`: the
   *  socket has been connected on this page before, so a connection it waits for is a reconnect, not the first. */
  onConnectionChange?: (connected: boolean, connectedBefore: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}


export function PaneTerminal({
  presentationKey,
  paneId,
  terminalId = null,
  mirrored = false,
  restoreError = null,
  agent = null,
  title = null,
  agentStatus,
  findRequest = 0,
  controls,
  active = true,
  autoSelected = false,
  focusRequest = 0,
  terminalFontSize,
  terminalWheelSpeed,
  terminalFontFamily,
  theme,
  palette,
  role = "interact",
  onRoleAck,
  onConnectionChange,
  onServerMessage,
}: PaneTerminalProps) {
  const t = useT();
  const activeRef = useRef(active);
  activeRef.current = active;
  const machineId = useMachineId();
  const machineSessions = useMachineSessions();
  const submitRetention = useContext(PaneSubmitContext);
  const presented = useContext(PanePresentedContext);
  const presentedRef = useRef(presented); presentedRef.current = presented;
  const cached = useContext(PaneCachedContext);
  const cachedRef = useRef(cached); cachedRef.current = cached;
  // a split tab's pane a phone keeps behind the one it shows sizes nothing: the pty is shared with
  // every device, and a PC drawing the split would see it at the phone's size (#819)
  const shown = useContext(PaneShownContext);
  const shownRef = useRef(shown); shownRef.current = shown;
  // the split half following the other half's grid of the same tab sizes nothing either
  const follow = useContext(PaneFollowContext);
  const followRef = useRef(follow); followRef.current = follow;
  const sizesPty = (): boolean => presentedRef.current && shownRef.current && !followRef.current;
  const { uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const [findOpen, setFindOpen] = useState(false);
  const [terminal, setTerminal] = useState<TerminalScreen | null>(null);
  const [searchState, setSearchState] = useState<TerminalSearchState | null>(null);
  const viewportIntent = useMemo(() => new ViewportIntentGate(), [machineId, paneId]);
  const viewportSearching = useSyncExternalStore(viewportIntent.subscribe, viewportIntent.isSearching, viewportIntent.isSearching);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const lastFindRequest = useRef(findRequest);
  useLayoutEffect(() => { findOpenRef.current = false; setFindOpen(false); }, [paneId]);
  useLayoutEffect(() => {
    if (findRequest !== lastFindRequest.current) {
      lastFindRequest.current = findRequest;
      if (findRequest > 0 && activeRef.current) {
        findOpenRef.current = true;
        setFindOpen(true);
      }
    }
  }, [findRequest]);
  // what the grid's region announces: the pane's own name, or the grid's kind while none is open
  const terminalName = terminalLabel(paneId, title, t);
  /** read by the wheel handler, which is attached once for the terminal's life */
  const wheelStateRef = useRef({ speed: terminalWheelSpeed, omoQuestion: false });
  wheelStateRef.current = { speed: terminalWheelSpeed, omoQuestion: agent === "omo" && agentStatus === "blocked" };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pinchBadgeRef = useRef<HTMLSpanElement | null>(null);
  const pinchStatusRef = useRef<HTMLSpanElement | null>(null);
  /** the user's font size (settings, or a pinch in progress) */
  const baseFontRef = useRef(terminalFontSize);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const pageScroll = useRef<((direction: -1 | 1) => void) | null>(null);
  const lineScroll = useRef<((lines: number) => void) | null>(null);
  const termRef = useRef<ResttyTerminal | null>(null);
  /** the pane's screen as the bridge syncs it, drawn into the terminal with local echo on top (lib/ssp) */
  const viewRef = useRef<SspView | null>(null);
  /** fits the grid to the mount (the user's font size first): false while the cell is not measured yet */
  const fitRef = useRef<(() => boolean) | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  /** the socket has been connected on this page before (connectedSockets): not connected, this terminal
   *  and the header say Reconnecting; before the first connection they say Connecting */
  const [connectedBefore, setConnectedBefore] = useState(false);
  const [outputReady, setOutputReady] = useState(false);
  const outputTarget = JSON.stringify([paneId, terminalId]);
  const outputTargetRef = useRef(outputTarget); outputTargetRef.current = outputTarget;
  const [parsedTarget, setParsedTarget] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // a 4008 overload close stopped this PC's shared connection: cleared when it comes back
  const stalledRef = useRef(false);
  // the server answered terminal_unsupported (a bridge too old to mirror): the grid is a notice
  const [unsupported, setUnsupported] = useState(false);
  // another web bridge has this pane's terminal: the server waits for it and says attach-resumed
  const [held, setHeldState] = useState(false);
  // what the socket handlers read mid-stream: stdin, onData and the input line's submit
  const heldRef = useRef(false);
  const setHeld = useCallback((next: boolean) => { heldRef.current = next; setHeldState(next); }, []);
  // The ref is what input handlers read; the state is what the key bar shows.
  const composingRef = useRef(false);
  const [composing, setComposingState] = useState(false);
  const setComposing = useCallback((active: boolean) => { composingRef.current = active; setComposingState(active); }, []);
  // a composition in the input line keeps the key bar live but blocks the switch to direct typing:
  // unmounting the line mid-composition could drop the word or replay it into the pane
  const lineComposingRef = useRef(false);
  const [lineComposing, setLineComposingState] = useState(false);
  const setLineComposing = useCallback((active: boolean) => { lineComposingRef.current = active; setLineComposingState(active); }, []);
  const compositionCommitPendingRef = useRef(false);
  const barKeyRef = useRef<{ key: string; chord: string | null } | null>(null);
  const modifiersRef = useRef<StickyModifiers>(NO_STICKY_MODIFIERS);
  const [modifiers, setModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const clearModifiers = useCallback(() => {
    modifiersRef.current = NO_STICKY_MODIFIERS;
    setModifiers(NO_STICKY_MODIFIERS);
    barKeyRef.current = null;
  }, []);
  useLayoutEffect(clearModifiers, [paneId, active, clearModifiers]);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  // a mirrored pane (no terminal attach on its PC): the grid is the pane's own in herdr, adopted like an observer's
  const fixedGridRef = useRef(false);
  const mirroredRef = useRef(mirrored); mirroredRef.current = mirrored;
  // the pty's grid as the server last said it for this pane (pane-geometry), whoever set it
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  // takes the pty back to this grid when another device left it at its own (the effect below sets it)
  const reassertIfStaleRef = useRef<() => void>(() => undefined);
  // draws the grid again as adopted or not (data-adopted-grid), keeping the cursor's row in sight
  const followCursorRef = useRef<() => void>(() => undefined);
  // out of use, the tab let go of its pane (no attach) so herdr's own TUI has it back; it attaches
  // again when the user is back. The ref is what the socket handlers and the pane switch read
  const releasedRef = useRef(false);
  const [released, setReleasedState] = useState(false);
  const setReleased = useCallback((next: boolean) => { releasedRef.current = next; setReleasedState(next); }, []);
  // released, the tab still shows the pane read-only (the server's "watch", herdr's observer), which
  // leaves the pane at the size herdr's own window gives it; false on a server without it: paused
  const watchingRef = useRef(false);
  const [watching, setWatchingState] = useState(false);
  const setWatching = useCallback((next: boolean) => { watchingRef.current = next; setWatchingState(next); }, []);
  // the mount effect's initial-attach decision, also used for a replacement pane
  const deferAttachRef = useRef<(pane: string) => boolean>(() => false);
  // the mount effect's release, for the input line: a tab that kept its pane for a line lets go once it went
  const releaseRef = useRef<() => void>(() => {});
  const presentationRef = useRef<() => void>(() => {});
  // A cache release resumes from the existing screen, not the observer's replacement screen.
  const cachedReleaseRef = useRef(false);
  // the mount effect's leave, for the pane switch: a tab out of use from the start (a reload behind
  // another app) or moving on to the next pane there lets go of it too
  const leaveRef = useRef<() => void>(() => {});
  const cancelLeaveRef = useRef<() => void>(() => {});
  // the mount effect's in-place re-attach after the output stopped, for the banner's Reconnect
  const reattachRef = useRef<() => void>(() => {});
  // the mount effect's keyboard hold, for the fits outside it: before a fit, whether the soft keyboard
  // holds the grid (the fit then waits for the keyboard to go; `force` says it was to re-assert the
  // grid), and after one, that the grid is the host's again
  const keyboardHoldsRef = useRef<(force: boolean) => boolean>(() => false);
  const fittedRef = useRef<() => void>(() => {});
  const endedRef = useRef(false);
  // the modifyOtherKeys level the pane's program asked for, as this pane's stream last said it
  const modifyOtherKeysRef = useRef(0);
  const [observing, setObserving] = useState(false);
  const [secret, setSecret] = useState<{ pane: string; prompt: string } | null>(null);
  const secretRef = useRef<string | null>(null);
  const secretActive = secret !== null && secret.pane === paneId;
  // a touch screen writes in the terminal's input line; typing straight into the grid is chosen
  const coarse = useMediaQuery("(pointer: coarse)");
  // A touch screen reads a pane before it answers: picking a pane there never raises the
  // keyboard by itself, only a tap on the input line or the grid does. A desktop has no keyboard
  // to raise, and the pane it picks takes the typing at once.
  const coarseRef = useRef(coarse); coarseRef.current = coarse;
  const { settings, update: updateSettings } = useSettings();
  const availableModifiers = settings.keyBarItems.reduce((mask, item) => item.type === "modifier"
    ? mask | { ctrl: 4, alt: 2, shift: 1 }[item.modifier] : mask, 0);
  useLayoutEffect(() => {
    const current = modifiersRef.current;
    const next = { ctrl: current.ctrl && !!(availableModifiers & 4), alt: current.alt && !!(availableModifiers & 2), shift: current.shift && !!(availableModifiers & 1) };
    if (next.ctrl === current.ctrl && next.alt === current.alt && next.shift === current.shift) return;
    modifiersRef.current = next;
    setModifiers(next);
  }, [availableModifiers]);
  const shortcutSettings = useRef(settings.shortcutOverrides);
  shortcutSettings.current = settings.shortcutOverrides;
  // what the terminal effect says in a banner, in the language chosen since it was set up
  const tRef = useRef(t);
  tRef.current = t;
  /** read by the OSC 52 handler, which is attached once for the terminal's life */
  const osc52AllowedRef = useRef(settings.paneClipboard);
  osc52AllowedRef.current = settings.paneClipboard;
  // Settings → Use alongside herdr's own window: off (the default), a tab out of use keeps its pane and its size
  const releaseAwayRef = useRef(settings.releasePaneAway);
  releaseAwayRef.current = settings.releasePaneAway;
  // every device starts typing straight into the grid; the input line is a choice (key bar or Settings)
  const directTyping = settings.terminalInputMode !== "line";
  const inputLine = !directTyping;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  // input typed while disconnected, held for the user to review and send
  const [draftState, setDraftState] = useState<{ owner: string | null; value: InputDraft }>({ owner: null, value: EMPTY_DRAFT });
  const draft = draftState.value;
  const setDraft = useCallback((value: InputDraft | ((previous: InputDraft) => InputDraft)) => {
    const owner = paneRef.current ? paneStorageId(machineId, paneRef.current) : null;
    setDraftState((previous) => ({ owner, value: typeof value === "function" ? value(previous.owner === owner ? previous.value : EMPTY_DRAFT) : value }));
  }, [machineId]);
  const draftPaneRef = useRef<string | null>(null);
  // The pane whose held draft takes all later typing until Send or Discard: keys sent beside it would
  // reach the pty without the start the draft holds (`echo ` held, `rm -rf build` and Enter typed).
  // Set here on each render, and at once by onData when it holds a key, before that render comes.
  const draftHeldForRef = useRef<string | null>(null);
  draftHeldForRef.current = paneId !== null && draftState.owner === paneStorageId(machineId, paneId) && !draftIsEmpty(draft) ? paneId : null;
  useEffect(() => {
    if (!paneId || draftState.owner !== paneStorageId(machineId, paneId)) return;
    const key = `t-rex:terminal-draft:${draftState.owner}`;
    try { if (draftIsEmpty(draft)) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify({ ...draft, at: Date.now() })); } catch {}
  }, [draftState, paneId, machineId, draft]);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  paneRef.current = paneId;
  endedRef.current = ended;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  useEffect(() => {
    if (connected && socketRef.current !== null) connectedSockets.add(socketRef.current);
    if (connected && !connectedBefore) setConnectedBefore(true);
    if (active) onConnectionChangeRef.current?.(connected, connectedBefore || connected);
  }, [connected, connectedBefore, active]);

  useEffect(() => {
    if (active) onRoleAckRef.current?.(observing ? "observe" : "interact");
    else {
      termRef.current?.blur();
      if (stackRef.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  }, [active, observing]);

  // local echo guesses only while typing goes to the program, and never at a masked prompt
  const predicting = connected && inputReady && !observing && !secretActive && !held && !ended && !released;
  useEffect(() => { viewRef.current?.setPredicting(predicting); }, [predicting]);

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  // Install before the pane layout effect so resets cancel pending input before the next task.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    // what the terminal sends the program (onData, set once the socket is known below) and the keys
    // it is about to encode (onKey): restty calls these for the terminal's whole life
    let onData: (data: string) => void = () => undefined;
    let onKey: (event: KeyboardEvent) => boolean = () => true;
    const term = new ResttyTerminal(host, {
      fontSize: terminalFontSize,
      fonts: terminalFonts(terminalFontFamily),
      fontKey: sanitizeFontFamily(terminalFontFamily),
      theme: terminalColorsTheme(settings.terminalThemeName, terminalTheme(theme, palette)),
      ligatures: settings.terminalLigatures,
      renderer: settings.terminalRenderer,
      onData: (data) => onData(data),
      onKey: (event) => onKey(event),
    });
    // Every fit first settles the font: the user's size, whether the pane is alone or split.
    const fitGrid = (): boolean => {
      // Every local fit (lens, font, resume or initial attach) shares this entry point.
      // A following half keeps the adopted PTY grid, even when its viewport changes.
      if (followRef.current) return true;
      term.setFontSize(baseFontRef.current);
      return term.fit();
    };
    let compositionEndTimer: number | null = null;
    compositionCommitPendingRef.current = false;
    const compositionStart = () => {
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      compositionEndTimer = null;
      compositionCommitPendingRef.current = false;
      setComposing(true);
    };
    const compositionEnd = () => {
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      // restty's listener on its field sent the commit before this bubbling host listener.
      // Keep a key of the same task on the text path; a new composition cancels this clear.
      compositionCommitPendingRef.current = true;
      setComposing(false);
      compositionEndTimer = window.setTimeout(() => {
        compositionEndTimer = null;
        compositionCommitPendingRef.current = false;
      }, 0);
    };
    host.addEventListener("compositionstart", compositionStart);
    host.addEventListener("compositionend", compositionEnd);
    // iOS repeats a held ⌫ only while the field has text and wraps (#862). restty empties its field
    // after every edit; these bubble to the host after restty's own listeners and refill it.
    const textarea = term.textarea;
    const keepText = (event: Event): void => {
      if (event.target !== textarea || composingRef.current) return;
      if ((event instanceof KeyboardEvent || event instanceof InputEvent) && event.isComposing) return;
      if (event.type === "focusin" || event.type === "keydown") restoreDeleteRepeatCaret(textarea);
      if (event instanceof KeyboardEvent && event.keyCode === 229) return;
      keepDeleteRepeatText(textarea);
    };
    const keepTextOn = keyboardNeedsText(navigator) ? ["focusin", "keydown", "beforeinput", "input"] : [];
    for (const type of keepTextOn) host.addEventListener(type, keepText);
    if (keepTextOn.length) textarea.style.whiteSpace = "pre-wrap";

    // A key goes through here before restty encodes it; false keeps it from restty.
    // Ctrl+V lets the browser paste (restty sends the text, bracketed when the program asked):
    // as a key it would be 0x16, the agent's image-paste shortcut against the server's clipboard.
    // With text selected, Ctrl+C copies it instead of interrupting the pane.
    // A non-Latin layout (Korean, Russian...) reports its own character as the key, so the
    // physical key names the letter then; a Latin layout keeps its own (Dvorak's C is not KeyC).
    // An app shortcut is the app's alone: restty would still type it, and Ctrl+Shift+↓ reached the
    // pane it had just switched to as ESC[1;6B.
    let typedChord: string | null = null;
    /** Shift+Enter and Ctrl+Enter as the next Enter is to be sent (onData), and the key herdr sends for a mirror's Ctrl+Enter */
    let enterAs: string | null = null;
    let enterKey: string | null = null;
    /** Cmd+Backspace: the next DEL is the line's Ctrl+U on macOS */
    let commandBackspace = false;
    /** restty holds a selection: a drag made one; a click or a key ends it */
    let selectionActive = false;
    onKey = (event) => {
      if (isAppShortcut(event, shortcutSettings.current) || isBrowserZoomShortcut(event, isMac)) return false;
      if (event.type === "keydown" && event.keyCode === 229 && keyboardNeedsText(navigator)) restoreDeleteRepeatCaret(textarea);
      const composing = composingRef.current || event.isComposing || event.keyCode === 229;
      // restty has already sent compositionend's text before the next key reaches this hook.
      // While composition is active, no key (including WebKit's keyCode 229) reaches its keymap.
      if (composing) return false;
      if (hasModifiers(modifiersRef.current) && !term.inputDisabled && !composing && !event.metaKey) {
        const combined = {
          ctrl: modifiersRef.current.ctrl || event.ctrlKey,
          alt: modifiersRef.current.alt || event.altKey,
          shift: modifiersRef.current.shift || event.shiftKey,
        };
        // the chord names the key by its position on a non-Latin layout (ㅊ on KeyC is Ctrl+C)
        const chord = terminalChord(physicalKey(event.key, event.code), combined);
        const navigation = navigationSequence(event.key, combined);
        if (navigation !== null) {
          if (event.type === "keydown") { event.preventDefault(); term.input(navigation); }
          return false;
        }
        // A real clipboard shortcut still belongs to the browser. Soft Ctrl+V
        // (the held button plus a typed v) is a terminal chord, not a paste.
        const letter = clipboardKey(event.key, event.code);
        const clipboard = event.ctrlKey && !event.altKey && /^(c|v)$/.test(letter)
          && (letter === "v" || selectionActive);
        if (chord !== null && !clipboard) {
          if (event.type === "keydown") {
            event.preventDefault();
            typedChord = chord;
            // Go through the same readiness/role/secret checks as other input.
            term.input(event.key);
            typedChord = null;
          }
          return false;
        }
      }
      if (event.type !== "keydown") return true;
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) selectionActive &&= event.metaKey || event.ctrlKey;
      if (event.ctrlKey && !event.altKey && !event.metaKey) {
        const key = clipboardKey(event.key, event.code);
        if (key === "v") {
          // the paste lands on restty's field, which sends it
          if (document.activeElement !== textarea) textarea.focus({ preventScroll: true });
          return false;
        }
        if (key === "c" && selectionActive) {
          event.preventDefault();
          copySelection();
          // the next Ctrl+C interrupts, as in a terminal
          selectionActive = false;
          return false;
        }
      }
      // Cmd+C on a Mac copies the same text restty would copy from the screen alone
      if (isMac && event.metaKey && !event.ctrlKey && !event.altKey && selectionActive && clipboardKey(event.key, event.code) === "c") {
        event.preventDefault();
        copySelection();
        return false;
      }
      if (term.inputDisabled || composing) return true;
      // A non-composing delete is terminal input, not an edit of stale Gboard DOM context.
      if (event.key === "Backspace" || event.key === "Delete") textarea.value = "";
      // macOS Option+arrows move by word, as in the native terminal's readline bindings.
      if (isMac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        term.input(event.key === "ArrowLeft" ? "\x1bb" : "\x1bf");
        return false;
      }
      // Ctrl+Left and Ctrl+Right are CSI 1;5 D and C, as in Ghostty and xterm: restty's own keymap
      // turns them into the shell's word moves (ESC b, ESC f), which a full-screen program never asked for
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        term.input(`\x1b[1;5${event.key === "ArrowLeft" ? "D" : "C"}`);
        return false;
      }
      // restty types Shift+Enter and Ctrl+Enter as plain Enter while the program has not asked for
      // the kitty keyboard protocol: Shift+Enter becomes the Alt+Enter newline chord, Ctrl+Enter
      // what modifyOtherKeys makes it (Claude Code's "send now") while the program has asked for
      // that, and stays Enter otherwise. A mirrored pane never hears that request, so its Ctrl+Enter
      // goes as herdr's key, which herdr encodes as the program asked.
      const kitty = (viewRef.current?.screen?.modes.kittyKeyboard ?? 0) !== 0;
      // Legacy restty drops Alt on Enter and Ctrl/Alt on Backspace. Preserve the terminal's
      // established sequences; kitty-mode encoding remains restty's own.
      if (!kitty && event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        term.input("\u001b\r");
        return false;
      }
      if (!kitty && event.key === "Backspace" && (event.ctrlKey || event.altKey)) {
        event.preventDefault();
        term.input(event.ctrlKey ? "\b" : "\u001b\u007f");
        return false;
      }
      if (event.key === "Enter" && !event.altKey && !event.metaKey && !kitty && event.shiftKey !== event.ctrlKey) {
        event.preventDefault();
        if (event.shiftKey) enterAs = "\x1b\r";
        else {
          enterKey = mirroredCtrlEnterKey(fixedGridRef.current, modifyOtherKeysRef.current);
          enterAs = enterKey !== null ? "\r" : ctrlEnterSequence(modifyOtherKeysRef.current);
        }
        term.input("\r");
        enterAs = null;
        enterKey = null;
        return false;
      }
      // Meta+arrows outside plain macOS Cmd+arrow belong to the browser, not restty's word-navigation map.
      if (event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")
        && (!isMac || event.ctrlKey || event.altKey || event.shiftKey)) return false;
      if (!isMac || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true;
      // Cmd+Backspace uses the terminal's Ctrl+U line-deletion shortcut on macOS
      if (event.key === "Backspace") {
        event.preventDefault();
        commandBackspace = true;
        term.input("\x7f");
        commandBackspace = false;
        return false;
      }
      // Cmd+arrows move to the line's start and end, as in a macOS text field
      const sequence = event.key === "ArrowLeft" ? "\x01" : event.key === "ArrowRight" ? "\x05" : null;
      if (sequence === null) return true;
      event.preventDefault();
      term.input(sequence);
      return false;
    };
    const stopWheel = attachTerminalWheel(host, wheelStateRef, {
      drag: (event) => dragWheel(event),
      adopted: () => adopted(),
      scroll: (lines) => lineScroll.current?.(lines),
      reporting: () => term.mouseReporting(),
    });
    termRef.current = term;
    fitRef.current = fitGrid;

    // A grid that is not this browser's own (observing, or mirrored from a PC that cannot
    // attach) may be larger than the mount. The mount then scrolls (PaneTerminal.css) and a
    // drag pans it. Until the user pans, the view keeps the cursor's row in sight: the top of
    // the grid while the row fits there, else the bottom rows, where a prompt sits. A mirror
    // has no cursor; the last row stands for it, where a prompt sits too.
    // the split's other half drawing the active half's tab follows the grid that half gives the pty
    const adopted = (): boolean => observeRef.current || fixedGridRef.current || followRef.current;
    // The soft keyboard takes the bottom of the screen, not the pane: a fit to what is left above
    // it would size the shared pty to that strip, and every other viewer of the pane, herdr's own
    // window included, would reflow twice per keyboard (#1045). While the keyboard is up, a host
    // that only lost height keeps its grid and the view pans to the cursor as an adopted grid's
    // does; the fit it held back runs once the keyboard goes (the host grows, the observer fits).
    let keyboardHeld = false;
    /** the host's width at its last fit: a width that changed (a rotation) refits under the keyboard too */
    let fittedWidth: number | null = null;
    /** a fit the keyboard held back was to re-assert the grid (force): the catch-up fit does so */
    let heldForce = false;
    let panned = false;
    const followCursor = (): void => {
      host.toggleAttribute("data-adopted-grid", adopted());
      if (!(adopted() || keyboardHeld) || panned) return;
      const row = term.cellSize().height;
      const cursorRow = viewRef.current?.screen?.cursor.row ?? term.rows - 1;
      const cursorBottom = (Math.min(cursorRow, term.rows - 1) + 1) * row;
      const max = host.scrollHeight - host.clientHeight;
      host.scrollTop = cursorBottom <= host.clientHeight ? 0 : cursorBottom - row >= max ? max : cursorBottom - host.clientHeight;
    };
    followCursorRef.current = () => { panned = false; followCursor(); };
    /** before a fit: true when the keyboard holds the grid, and the fit waits (`force`: it was to re-assert the grid) */
    const keyboardHolds = (force: boolean): boolean => {
      if (!keyboardHoldsGrid(keyboardUp(), host.clientWidth, fittedWidth)) return false;
      keyboardHeld = true;
      heldForce ||= force;
      // the pane may be at another device's grid: drawn as it is until the keyboard goes, when the
      // catch-up fit takes the pane back (as a tap or key in the grid would)
      const shared = sharedGridRef.current;
      if (shared && !adopted() && (term.cols !== shared.cols || term.rows !== shared.rows)) {
        term.resize(shared.cols, shared.rows);
        heldForce = true;
      }
      panned = false;
      followCursor();
      return true;
    };
    /** after a fit: the grid is the host's again, with nothing left to pan to */
    const fitted = (): void => {
      fittedWidth = host.clientWidth;
      keyboardHeld = false;
      heldForce = false;
      // a view panned under the keyboard would stay panned past the grid's top
      host.scrollTop = 0;
    };
    keyboardHoldsRef.current = keyboardHolds;
    fittedRef.current = fitted;

    let disposed = false;
    /** the text of the last selection: herdr's own for its range once herdr answers, the screen's until then */
    let copiedText: string | null = null;
    /** bumped by every press: an older selection's answer from herdr never lands in the clipboard */
    let selectionGeneration = 0;
    /** a copy this terminal started: the copy event it raises carries copiedText */
    let copying = false;
    const onCopy = (event: ClipboardEvent): void => {
      if (!copying || copiedText === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", copiedText);
      event.preventDefault();
    };
    // capturing: ahead of any other listener that reads what is copied
    window.addEventListener("copy", onCopy, true);
    /** Copies the selection's text, as the user's own Copy would. */
    const copySelection = (): void => {
      const text = copiedText;
      if (!text) return;
      // Native copy still works in a user gesture when a Chromium/PWA site has
      // denied the async clipboard permission, or plain HTTP has no clipboard API.
      copying = true;
      let copied = false;
      try { copied = document.execCommand("copy"); } finally { copying = false; }
      if (copied) {
        noteClipboard("copied to clipboard");
        return;
      }
      if (!navigator.clipboard) {
        noteClipboard("clipboard write blocked by the browser");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => { if (!disposed) noteClipboard("copied to clipboard"); },
        () => { if (!disposed) noteClipboard("clipboard write blocked by the browser"); },
      );
    };

    // herdr's attach stream turns mouse reporting on, so restty hands every press to the program
    // and selects only with Shift held. Selection lives in herdr's own TUI client, not in
    // `herdr terminal attach`, so a left drag here selects as if Shift were held (Option on macOS
    // too), and letting go copies, as the herdr TUI does; a double click selects a word and copies
    // it; a press let go in place is a click and goes to the program (forwardClick), and a press
    // on a link opens it. Touch keeps its drag-to-scroll (below).
    //
    // What is copied is herdr's own text for the range (a line longer than the grid is wide is one
    // line there, where the screen shows it on two rows), asked for on the release; the screen's
    // text goes first, in the gesture, and stays when herdr cannot answer (plain HTTP, observing,
    // an older bridge, a failed read).
    interface Cell { row: number; col: number }
    interface ClickKeys { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
    interface Press {
      pane: string;
      /** the pressed cell */
      cell: Cell;
      /** the press left its cell: a drag, even one that comes back */
      moved: boolean;
      /** Shift was added for restty: its release must carry it too */
      forced: boolean;
      /** a press the program would have had but for the forced selection, with the keys the user held: let go in place, it is a click */
      click: ClickKeys | null;
      /** herdr's history row at the top of the screen, once herdr has told */
      top: number | null;
      /** the second press of a double click, on the cell of the first */
      double: boolean;
      /** the web address pressed on: this press is the link's, and restty never sees it */
      link: string | null;
      /** the pressed cell's row in herdr's history */
      anchorRow: number;
      /** herdr's viewport as the drag scrolls it: rows from the bottom, and the most there are */
      offset: number;
      maxOffset: number;
      /** the drag scrolled herdr: its range runs past what the screen shows */
      scrolled: boolean;
      /** the cell under the pointer, kept on the grid, and the edge it is past: above (-1) or below (1) */
      cursor: Cell;
      edge: -1 | 0 | 1;
      wheelPixels: number;
      sentOffset: number;
      sending: boolean;
    }
    let press: Press | null = null;
    /** the last click let go in place: a press soon after on its cell makes a double click (a
     *  pointer event's own count is always 0) */
    let lastClick: { at: number; cell: Cell } | null = null;
    const DOUBLE_CLICK_MS = 500;
    /** the row under a point, on the grid or past an edge of it */
    const rowAt = (event: { clientY: number }): number =>
      Math.floor((event.clientY - (term.canvas ?? host).getBoundingClientRect().top) / term.cellSize().height);
    /** the cell under a point, kept on the grid */
    const cellAt = (event: { clientX: number; clientY: number }): Cell => {
      const rect = (term.canvas ?? host).getBoundingClientRect();
      const col = Math.floor((event.clientX - rect.left) / term.cellSize().width);
      return { row: Math.max(0, Math.min(term.rows - 1, rowAt(event))), col: Math.max(0, Math.min(term.cols - 1, col)) };
    };
    const ordered = (a: Cell, b: Cell): [Cell, Cell] =>
      a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    /** The synced screen's text from `start` to `end`, both inclusive, its rows parted by line breaks. */
    const screenRange = (start: Cell, end: Cell): string => {
      const frame = viewRef.current?.screen;
      if (!frame) return "";
      const lines: string[] = [];
      for (let row = start.row; row <= end.row; row++) {
        const line = frame.lines[row];
        if (!line) continue;
        const cells = decodeRow(line.wire, frame.cols);
        const from = row === start.row ? start.col : 0;
        const to = row === end.row ? end.col : frame.cols - 1;
        lines.push(cells.slice(from, to + 1).map((cell) => cell.text).join("").trimEnd());
      }
      return lines.join("\n");
    };
    /** The word around a cell, as a double click takes it: up to blanks, quotes and brackets. */
    const wordAt = (at: Cell): [Cell, Cell] | null => {
      const frame = viewRef.current?.screen;
      const line = frame?.lines[at.row];
      if (!frame || !line) return null;
      const cells = decodeRow(line.wire, frame.cols);
      const isWord = (col: number): boolean => {
        const text = cells[col]?.text ?? " ";
        return text === "" || !/^[\s"'`()[\]{}<>|,;]$/.test(text);
      };
      if (!isWord(at.col) || cells[at.col]?.text === "") return null;
      let from = at.col;
      let to = at.col;
      while (from > 0 && isWord(from - 1)) from--;
      while (to < frame.cols - 1 && isWord(to + 1)) to++;
      return [{ row: at.row, col: from }, { row: at.row, col: to }];
    };
    /** Takes a selection's text: the screen's at once, then herdr's for the same range. */
    const select = (p: Press, start: Cell, end: Cell): void => {
      if (p.top === null) copyRange(p, screenRange(start, end), null);
      else copyRange(p, screenRange(start, end), [{ row: p.top + start.row, col: start.col }, { row: p.top + end.row, col: end.col }]);
    };
    /** A drag that scrolled herdr: its range is in history rows, and the screen shows a part of it. */
    const selectHistory = (p: Press, start: Cell, end: Cell): void => {
      const top = p.top!;
      const first = Math.max(start.row, top);
      const last = Math.min(end.row, top + term.rows - 1);
      const visible = first > last ? "" : screenRange(
        first === start.row ? { row: start.row - top, col: start.col } : { row: first - top, col: 0 },
        last === end.row ? { row: end.row - top, col: end.col } : { row: last - top, col: term.cols - 1 });
      copyRange(p, visible, [start, end]);
    };
    /** Copies `visible` at once, in the gesture, then herdr's own text for `range` (history rows) once it answers. */
    const copyRange = (p: Press, visible: string, range: [Cell, Cell] | null): void => {
      selectionActive = true;
      copiedText = visible;
      copySelection();
      if (range === null || (!visible && !p.scrolled)) return;
      const generation = selectionGeneration;
      const current = (): boolean => !disposed && paneRef.current === p.pane && generation === selectionGeneration;
      const text = fetchPaneSelection(p.pane, range[0], range[1], machineId)
        .catch(() => visible)
        .then((value) => {
          if (!current()) throw new Error("selection changed");
          // A redraw can remove the range before herdr reads it. Keep what the user
          // actually selected instead of replacing a successful copy with nothing.
          copiedText = value || visible;
          return copiedText;
        });
      // Reserve the write NOW, in the gesture, supplying herdr's text when it arrives. Never
      // start a fresh clipboard write from a delayed response or an older selection.
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
        void blob.catch(() => {});
        void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {});
      } else void text.catch(() => {});
    };
    const forceSelection = (event: PointerEvent): void => {
      Object.defineProperty(event, "shiftKey", { value: true });
    };
    /**
     * The web address drawn at a cell: an OSC 8 link the screen carries, or an address printed as
     * plain text, as a terminal shows it. Opened here, never by restty, which would open a popup
     * window and take any scheme a line names.
     */
    const linkAt = (at: Cell): string | null => {
      const linked = viewRef.current?.linkAt(at.row, at.col) ?? null;
      if (linked !== null) return isWebLink(linked) ? linked : null;
      const frame = viewRef.current?.screen;
      const line = frame?.lines[at.row];
      return frame && line ? webLinkAt(decodeRow(line.wire, frame.cols).map((cell) => cell.text), at.col) : null;
    };
    /** the pointer over a link shows it can be clicked */
    let pointerOnLink = false;
    const onHover = (event: PointerEvent): void => {
      if (event.pointerType !== "mouse" || event.buttons !== 0 || !term.canvas) return;
      const on = linkAt(cellAt(event)) !== null;
      if (on) term.canvas.style.cursor = "pointer";
      else if (pointerOnLink) term.canvas.style.cursor = "";
      pointerOnLink = on;
    };
    const onPointerDown = (event: PointerEvent): void => {
      // a click handed on to the program (forwardClick) is not a new press
      if (event.pointerType !== "mouse" || event.button !== 0 || !event.isTrusted) return;
      if (!term.element.contains(event.target as Node)) return;
      const reporting = term.mouseReporting();
      const cell = cellAt(event);
      // a press on a link opens it: neither restty nor the program gets it
      const link = linkAt(cell);
      if (link !== null) {
        event.preventDefault();
        event.stopPropagation();
        press = {
          pane: paneRef.current ?? "", cell, moved: false, forced: false, click: null, top: null, double: false, link,
          anchorRow: 0, offset: 0, maxOffset: 0, scrolled: false, cursor: cell, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false,
        };
        return;
      }
      // a press that ends a selection or makes a double click is not the program's click either
      const double = lastClick !== null && performance.now() - lastClick.at < DOUBLE_CLICK_MS
        && lastClick.cell.row === cell.row && lastClick.cell.col === cell.col;
      const click: ClickKeys | null = reporting && !selectionActive && !double
        ? { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey } : null;
      if (reporting) forceSelection(event);
      selectionGeneration++;
      copiedText = null;
      const p: Press = {
        pane: paneRef.current ?? "", cell, moved: false, forced: reporting, click, top: null, double, link: null,
        anchorRow: 0, offset: 0, maxOffset: 0, scrolled: false, cursor: cell, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false,
      };
      press = p;
      stopEdge();
      // herdr's row at the top of the screen: the release asks herdr for the range's own text, and
      // a drag can scroll herdr's history past the screen
      if (!p.pane || !navigator.clipboard || observeRef.current) return;
      void fetchPaneScroll(p.pane, machineId).then((scroll) => {
        if (!scroll || p.scrolled) return;
        p.offset = p.sentOffset = scroll.offset_from_bottom;
        p.maxOffset = scroll.max_offset_from_bottom;
        p.top = p.maxOffset - p.offset;
        p.anchorRow = p.top + p.cell.row;
      }, () => {});
    };
    /** one scroll request at a time; the latest wanted offset wins */
    const sendScroll = (p: Press): void => {
      if (p.sending || p.sentOffset === p.offset) return;
      p.sending = true;
      const target = p.offset;
      void scrollPane(p.pane, target, machineId).catch(() => {}).finally(() => {
        p.sending = false;
        p.sentOffset = target;
        sendScroll(p);
      });
    };
    /** Scrolls herdr's history under a drag: positive lines show older text. */
    const scrollDrag = (p: Press, lines: number): void => {
      if (p.top === null) return;
      const offset = Math.max(0, Math.min(p.maxOffset, p.offset + lines));
      if (offset === p.offset) return;
      p.offset = offset;
      p.top = p.maxOffset - offset;
      p.scrolled = true;
      sendScroll(p);
    };
    let edgeTimer: number | null = null;
    const stopEdge = (): void => {
      if (edgeTimer !== null) window.clearInterval(edgeTimer);
      edgeTimer = null;
    };
    /** A wheel while pressing scrolls herdr's history under the drag (through the API, never as input). */
    const dragWheel = (event: WheelEvent): boolean => {
      const p = press;
      if (!p) return false;
      const lineHeight = term.cellSize().height;
      const { steps: lines, rest } = wheelSteps(
        p.wheelPixels + (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * lineHeight : event.deltaY), lineHeight);
      p.wheelPixels = rest;
      p.moved = true;
      if (lines !== 0) scrollDrag(p, -lines);
      return true;
    };
    const onPointerMove = (event: PointerEvent): void => {
      const p = press;
      if (!p || event.pointerType !== "mouse") return;
      const row = rowAt(event);
      const edge: -1 | 0 | 1 = row < 0 ? -1 : row >= term.rows ? 1 : 0;
      const cell = cellAt(event);
      // past an edge, the edge row is taken whole
      p.cursor = edge < 0 ? { row: 0, col: 0 } : edge > 0 ? { row: term.rows - 1, col: term.cols - 1 } : cell;
      if (cell.row !== p.cell.row || cell.col !== p.cell.col || edge !== 0) p.moved = true;
      // a pointer past the top or bottom edge keeps scrolling herdr's history
      if (p.top === null || edge === p.edge) return;
      p.edge = edge;
      stopEdge();
      if (edge !== 0) edgeTimer = window.setInterval(() => scrollDrag(p, -p.edge), 60);
    };
    // the release of a forced press carries the Shift restty selected with, or it would report a
    // release the program never saw pressed
    const onPointerRelease = (event: PointerEvent): void => {
      if (event.pointerType !== "mouse" || !event.isTrusted) return;
      const p = press;
      if (p?.link) {
        // a link's press ends here: restty never sees it (and nothing after this listener does)
        event.stopPropagation();
        press = null;
        if (event.button === 0 && !p.moved && p.pane !== "" && p.pane === paneRef.current) openWebLink(p.link);
      } else if (p?.forced) forceSelection(event);
    };
    // A press that became no selection was a click, and a program that reads the mouse (a
    // close button in Claude Code's diff, a TUI's menu) expects it: herdr's attach forwards
    // left clicks to it, as a phone's tap already showed (#621). The press and release are
    // replayed without the added Shift so restty encodes them in the reporting mode herdr asked
    // for; nothing is sent while input is off (observing, a held pane).
    const forwardClick = (at: { clientX: number; clientY: number }, keys: ClickKeys): void => {
      const target = term.canvas;
      if (!target) return;
      const init = { ...keys, bubbles: true, cancelable: true, view: window, button: 0, detail: 1, clientX: at.clientX, clientY: at.clientY, pointerId: 1, pointerType: "mouse", isPrimary: true };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    };
    // a release outside the window never arrives
    const onBlur = (): void => { press = null; stopEdge(); };
    // after restty's own release: its selection is made, or the click has ended it. restty
    // cancels the press, so no mouseup follows: this release is the gesture a clipboard write
    // starts in
    const onPointerUp = (event: PointerEvent): void => {
      const p = press;
      if (!p || event.pointerType !== "mouse" || event.button !== 0) return;
      press = null;
      stopEdge();
      // released on the pane it was pressed on: a pane switched meanwhile gets nothing of this press
      if (p.pane === "" || p.pane !== paneRef.current) return;
      if (p.moved) {
        lastClick = null;
        if (p.scrolled && p.top !== null) {
          const [start, end] = ordered({ row: p.anchorRow, col: p.cell.col }, { row: p.top + p.cursor.row, col: p.cursor.col });
          selectHistory(p, start, end);
          return;
        }
        const row = rowAt(event);
        const end = row < 0 ? { row: 0, col: 0 } : row >= term.rows ? { row: term.rows - 1, col: term.cols - 1 } : cellAt(event);
        const [start, stop] = ordered(p.cell, end);
        select(p, start, stop);
        return;
      }
      lastClick = p.double ? null : { at: performance.now(), cell: p.cell };
      if (p.double) {
        const word = wordAt(p.cell);
        if (word && term.selectWordAt(event.clientX, event.clientY)) {
          select(p, word[0], word[1]);
          return;
        }
      }
      // a click in place ended any selection
      selectionActive = false;
      if (p.click) forwardClick(event, p.click);
    };
    host.addEventListener("pointerdown", onPointerDown, { capture: true });
    host.addEventListener("pointermove", onHover);
    host.addEventListener("pointerup", onPointerRelease, { capture: true });
    window.addEventListener("pointermove", onPointerMove, { capture: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", onBlur);

    // OSC 52: the pane program asked the terminal to set the clipboard - the pty cannot reach the
    // browser clipboard by itself, so the synced screen carries the write as an event (the view
    // hands it over) and navigator.clipboard completes the hop (text only; queries are ignored).
    // On unless turned off in Settings -> Terminal -> Clipboard from a pane: vim, tmux and Claude Code
    // copy this way, but any process in the pane, an agent's tool calls included, can plant text the
    // user then pastes somewhere else.
    const writeClipboard = (payload: string): void => {
      if (!osc52AllowedRef.current) return;
      const text = parseOsc52(payload);
      if (text === null) return;
      void navigator.clipboard?.writeText(text).then(
        () => noteClipboard("copied to clipboard"),
        () => noteClipboard("clipboard write blocked by the browser"),
      );
    };

    // The authenticated app owns the PC connection; this mount owns only one pane's attach.
    const session = machineSessions?.get(machineId) ?? new MachineSession(machineId);
    const socket = session.socket;
    socketRef.current = socket;
    // a socket this page was connected to before this mount (a switch back to the PC): a wait is a reconnect
    setConnectedBefore(connectedSockets.has(socket));
    // The screen comes as differences from the bridge's own (shared/ssp.ts): the view keeps it,
    // guesses at what typing will show, and draws both into restty, which shows nothing else.
    const outputListeners = new Set<() => void>();
    const view = new SspView({
      write: (data) => term.write(data),
      ack: (stream, num) => { const pane = paneRef.current; if (pane) socket.sspAck(pane, stream, num); },
      ackAsset: (stream, key, offset) => { const pane = paneRef.current; if (pane) socket.sspAssetAck(pane, stream, key, offset); },
      clipboard: writeClipboard,
      linkAllowed: isWebLink,
      // the modes the program asked for, as the bridge's screen has them (Ctrl+Enter reads modifyOtherKeys)
      screen: (frame) => { modifyOtherKeysRef.current = frame.modes.modifyOtherKeys; },
    });
    viewRef.current = view;
    // what the grid shows, read by browser regressions (docs/development.md): a canvas holds no text
    Object.defineProperty(term.element, "screen", { configurable: true, value: () => ({
      ...view.shown(), cols: term.cols, rows: term.rows, cell: term.cellSize(), fontSize: term.currentFontSize,
      // the selection's text as it would be copied (restty draws the highlight on the canvas), null without one
      selection: selectionActive ? copiedText ?? "" : null,
    }) });
    view.setSize(term.cols, term.rows);
    const offViewResize = term.onResize((cols, rows) => view.setSize(cols, rows));
    // what the tools over the grid read (TerminalViewportTools): the synced screen's cells
    const decoded = new WeakMap<object, ReturnType<typeof decodeRow>>();
    setTerminal({
      element: term.element,
      get cols() { return term.cols; },
      get rows() { return term.rows; },
      cellSize: () => term.cellSize(),
      cell: (row, col) => {
        const frame = view.screen;
        const line = frame?.lines[row];
        if (!frame || !line) return undefined;
        let cells = decoded.get(line);
        if (!cells) decoded.set(line, cells = decodeRow(line.wire, frame.cols));
        const cell = cells[col];
        return cell ? { chars: cell.text, width: cell.width } : undefined;
      },
      onOutput: (listener) => { outputListeners.add(listener); return () => { outputListeners.delete(listener); }; },
      onResize: (listener) => term.onResize(() => listener()),
    });
    // the grid is measured once the fonts load: the estimate the attach was sized with may be off
    const offReady = term.onReady(() => {
      if (adopted()) {
        const shared = sharedGridRef.current;
        if (shared) term.resize(shared.cols, shared.rows);
        followCursor();
        return;
      }
      if (!sizesPty() || keyboardHolds(false)) return;
      const before = `${term.cols}x${term.rows}`;
      fitGrid();
      fitted();
      const pane = paneRef.current;
      if (pane && inUse() && `${term.cols}x${term.rows}` !== before) socket.resize(pane, term.cols, term.rows);
    });
    // a readiness receipt that says the output is recovering: the next stream, not input permission
    // (which observers never have), proves the screen is current again
    let outputRecovering = false;
    /** the pane (and terminal) whose first screen was drawn */
    let shownTarget: string | null = null;
    let deferredAttach = false;
    // What is typed while the input cannot take it is held for the user to send or discard.
    const holdForReview = (current: string, input: string): void => {
      if (draftPaneRef.current !== current) {
        draftPaneRef.current = current;
        setDraft(EMPTY_DRAFT);
      }
      setDraft((prev) => applyToDraft(prev, input));
      if (!draftIsEmpty(applyToDraft(EMPTY_DRAFT, input))) draftHeldForRef.current = current;
    };
    // A pane just picked shows its screen a moment before herdr says its input is ready: what is
    // typed in that moment reaches the pane once it is, as a terminal's typeahead does. A drop, a
    // refusal or no answer in TYPEAHEAD_MS holds it for review instead, and never sends it later.
    // Kept key by key: held, each one edits the draft as it would have when typed.
    let typeahead: { pane: string; inputs: string[]; timer: number } | null = null;
    const settleTypeahead = (): void => {
      const pending = typeahead;
      if (pending === null) return;
      typeahead = null;
      window.clearTimeout(pending.timer);
      // this terminal has moved on to another pane: neither pane's pty nor draft takes it
      if (pending.pane !== paneRef.current) return;
      const text = pending.inputs.join("");
      if (presentedRef.current && shownRef.current && !followRef.current && !observeRef.current && !heldRef.current
        && socket.sendInput(pending.pane, text)) view.typed(text, socket.lastInputSeq(pending.pane));
      else for (const input of pending.inputs) holdForReview(pending.pane, input);
    };
    const off = session.on((message) => {
      onServerMessageRef.current?.(message);
      // Every pane-addressed frame, errors included, belongs only to that pane's renderer.
      if ("pane_id" in message && message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
      // the PC's shared connection came back after an overload close (another pane's mount, or an
      // explicit pick, reconnected it): its replayed attach serves this pane again
      if (message.type === "snapshot" && stalledRef.current) {
        stalledRef.current = false;
        setOutputError(null);
        setEnded(false);
        term.inputDisabled = observeRef.current || heldRef.current;
      }
      // A provisional watch must not strand an initial/reconnected pane on an older bridge.
      // An ordinary opt-in release still keeps its existing paused fallback.
      if (message.type === "snapshot" && deferredAttach && !socket.canWatch()) resume();
      if (paneRef.current) setInputReady(socket.canInput(paneRef.current));
      if (typeahead !== null && (socket.canInput(typeahead.pane) || message.type === "error" || message.type === "pty-exit"
        || (message.type === "input-ready" && message.ready === false))) settleTypeahead();
      if (message.type === "input-ready") {
        if (message.ready === false) {
          outputRecovering = true;
          setOutputReady(false);
          setParsedTarget(undefined);
        } else if (outputRecovering) {
          outputRecovering = false;
        }
      }
      if (message.type === "ssp-asset") {
        if (message.pane_id === paneRef.current && !releasedRef.current) view.receiveAsset(message.stream, message);
        return;
      }
      if (message.type === "ssp" || message.type === "pty-data") {
        if (message.pane_id !== paneRef.current || releasedRef.current) return;
        const owner = message.pane_id;
        const target = outputTargetRef.current;
        let screenText: string;
        let columns: number;
        if (message.type === "ssp") {
          view.receive(message);
          const screen = view.screen;
          if (!screen) return;
          screenText = view.text();
          columns = screen.cols;
        } else {
          // an older bridge streams raw pty bytes: append, never repaint, and the view's drawing is
          // gone. Its screen is restty's alone, so no masked prompt is found in it
          view.invalidate();
          term.write(message.data);
          screenText = "";
          columns = term.cols;
        }
        // restty parses a write at once (or, before its first frame, in order once it is up)
        {
          if (!outputRecovering) {
            setOutputReady(true);
            setParsedTarget(target);
          }
          // a pane's first screen, for the browser's performance tools (and the PR's numbers)
          if (shownTarget !== target) {
            shownTarget = target;
            performance.mark("terminal:first-screen", { detail: { pane: owner, ready: term.ready } });
          }
          for (const listener of [...outputListeners]) listener();
          followCursor();
          // A masked prompt does not close the grid: a desktop answers it there, as in any terminal,
          // and the masked input stands by for a phone (#1031). onData keeps what is typed then out
          // of every draft.
          const prompt = secretPrompt(screenText, columns);
          secretRef.current = prompt;
          term.inputDisabled = observeRef.current || heldRef.current;
          setSecret((previous) => previous?.pane === owner && previous.prompt === prompt ? previous : prompt ? { pane: owner, prompt } : null);
        }
      } else if (message.type === "watch-data") {
        // a read-only view drawn for this grid: written as it comes, never acknowledged
        if (message.pane_id !== paneRef.current || !releasedRef.current || !watchingRef.current) return;
        view.invalidate();
        term.write(message.data);
      } else if (message.type === "watch-end") {
        // the view ended: the last screen stays, and the banner says the tab is paused
        if (message.pane_id === paneRef.current) setWatching(false);
      } else if (message.type === "attach-resumed") {
        if (message.pane_id === paneRef.current) {
          setHeld(false);
          term.inputDisabled = observeRef.current;
        }
      } else if (message.type === "pty-exit") {
        // an ended pane takes no input: a file dropped on it must not upload and paste either
        // held input stays: the server also says pty-exit when herdr restarts or an attach fails,
        // and the same pane comes back; only the user sends or discards it
        if (message.pane_id === paneRef.current) { setEnded(true); term.inputDisabled = true; }
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client reclaim the shared grid it stopped owning (a tab out of use
        // reclaims it when the user comes back: the refit below)
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        setObserving(nowObserving);
        term.inputDisabled = nowObserving || heldRef.current;
        onRoleAckRef.current?.(message.mode);
        if (!nowObserving && !fixedGridRef.current && inUse() && !keyboardHolds(true)) {
          fitGrid();
          fitted();
          const pane = paneRef.current;
          if (pane && sizesPty()) socket.resize(pane, term.cols, term.rows, true);
        }
        panned = false;
        followCursor();
      } else if (message.type === "pane-geometry") {
        // observe clients adopt the pty's grid; interact clients drive it and ignore this,
        // unless the grid is fixed: then nobody here drives it
        if (message.pane_id !== paneRef.current) return;
        if (message.fixed) fixedGridRef.current = true;
        // kept while this terminal ignores it: another device may drive the grid
        sharedGridRef.current = { cols: message.cols, rows: message.rows };
        if (!observeRef.current && !fixedGridRef.current && !followRef.current) {
          if (!keyboardHeld) return;
          // a grid held under the keyboard draws the pane's own grid (an attach made under it adopted
          // the pane's size, another device may have sized it): the catch-up fit takes the pane back
          heldForce = true;
        }
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
        panned = false;
        followCursor();
      } else if (message.type === "error") {
        if (message.code === "input_not_ready" || message.code === "input_failed") {
          if (message.pane_id === paneRef.current) setInputError(message.message);
          return;
        }
        if (message.code === "attach_held") {
          // a pane this terminal already left: its wait is not this pane's
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // not an end: the server attaches as soon as the other bridge lets go
          setHeld(true);
          setOutputReady(false);
          term.inputDisabled = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "attach_failed") {
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // the server could not start herdr: nothing is coming, so say why instead of waiting
          setOutputError(t("herdr could not be started on the server, so this terminal cannot attach. Put herdr on the server's PATH or set HERDR_WEB_HERDR_BIN to its full path."));
          setEnded(true);
          term.inputDisabled = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "terminal_unsupported") {
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          setUnsupported(true);
          term.inputDisabled = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          if (message.code === "output_stalled") stalledRef.current = true;
          setOutputError(message.message);
          setEnded(true);
          setConnected(false);
          term.inputDisabled = true;
          // a frozen page reads the close after it is shown again, often after back() ran: the
          // stop belongs to the time it was put away, so attach again now (see back())
          if (message.code === "output_stalled" && socket.stoppedWhileHidden && inUse()) {
            queueMicrotask(() => {
              if (!disposed && stalledRef.current && socket.stoppedWhileHidden && inUse()) reattachRef.current();
            });
          }
          return;
        }
        // said in the grid itself, over the view's drawing: the next frame is drawn whole
        term.write(`\r\n\u001b[31m[T-Rex] ${message.code}: ${message.message}\u001b[0m\r\n`);
        view.invalidate();
      }
      setConnected(socket.connected);
    });
    const offDisconnect = session.onDisconnect(() => {
      settleTypeahead();
      clearModifiers();
      outputRecovering = false;
      setOutputReady(false);
      setInputReady(false);
      setConnected(false);
      // the reconnect attaches afresh: it says attach_held again if the other bridge still has
      // the pane, and a pane it gets straight away sends no attach-resumed to clear this
      setHeld(false);
      // and its stream says the keyboard modes again, from the start or in the replay
      modifyOtherKeysRef.current = 0;
    });
    session.connect();

    // input readiness too: a liveness probe refuses input without a frame to say so
    const poll = window.setInterval(() => {
      setConnected(socket.connected);
      if (paneRef.current) setInputReady(socket.canInput(paneRef.current));
    }, 1000);

    // A paste is text, even when it happens to contain just one letter. restty
    // handles the DOM paste synchronously after this capture-phase listener.
    let pasting = false;
    const onPaste = () => { pasting = true; queueMicrotask(() => { pasting = false; }); };
    host.addEventListener("paste", onPaste, true);
    // File paths and dropped text are pasted as a paste from the clipboard is (restty's own paste
    // event, which the listener above marks as one)
    const pasteText = (text: string): void => term.paste(text);
    onData = (data) => {
      // the split half following the other half's grid of the same tab draws it only: the active
      // half's terminal answers the program's queries (a second answer would reach it as typing),
      // and a press or key here makes this half the active one before anything is typed
      if (followRef.current) return;
      const barKey = barKeyRef.current;
      barKeyRef.current = null;
      const physicalChord = typedChord;
      typedChord = null;
      // a modified Enter (Shift+Enter's newline, Ctrl+Enter's "send now") is decided on before its
      // rewrite: its sequence may carry no line break at all
      const modifiedEnter = enterAs !== null && data === "\r";
      const enterChord = modifiedEnter ? enterKey : null;
      if (modifiedEnter) data = enterAs!;
      enterAs = null;
      enterKey = null;
      if (commandBackspace && data === "\x7f") data = "\x15";
      commandBackspace = false;
      const current = paneRef.current;
      // Hiding a cached pane blurs the terminal, which may commit its pending IME text.
      // That abandoned input must reach neither the old PTY nor its held draft.
      if (!current || !presentedRef.current || !shownRef.current || observeRef.current || heldRef.current) return;
      // typeahead goes before anything typed after it, once the pane can take it (an older bridge
      // says so with its output, not with a frame)
      if (typeahead !== null && (typeahead.pane !== current || socket.canInput(typeahead.pane))) settleTypeahead();
      // while a masked prompt is on screen, what is typed goes to the program or nowhere: never
      // into a draft, which is kept in the clear and offered back for review
      const secret = secretRef.current !== null;
      const input = data;
      const key = keyFromData(data);
      const chord = enterChord ?? (!pasting && !composingRef.current && !compositionCommitPendingRef.current
        ? barKey !== null ? barKey.chord
          : physicalChord ?? (hasModifiers(modifiersRef.current) && key !== null ? terminalChord(key, modifiersRef.current) : null)
        : null);
      if (draftHeldForRef.current === current) {
        // A chord or a modified Enter is never held, and never sent beside held text either
        // (Ctrl+J, or Ctrl+Enter under modifyOtherKeys, would run the line).
        // A paste the draft cannot take (an unbracketed tab or control character) is refused too, never sent
        // ahead of the held start.
        const pasted = pasting || input.startsWith("\x1b[200~");
        if (chord !== null || modifiedEnter || (pasted && applyToDraft(EMPTY_DRAFT, input) === EMPTY_DRAFT)) {
          const t = tRef.current;
          setInputError(t("Not sent: send or discard the held input first."));
          return;
        }
        // Text, a paste, Backspace and anything with a line break go to the draft, which leaves
        // Enter out, so a partial command never runs. Other control keys (Ctrl+C, Escape, Tab,
        // arrows) still reach the program below: an interrupt must not wait on the draft.
        if (pasted || /[\r\n\x7f\b]/.test(input) || applyToDraft(EMPTY_DRAFT, input) !== EMPTY_DRAFT) {
          if (secret) {
            const t = tRef.current;
            setInputError(t("Not sent: send or discard the held input first."));
            return;
          }
          setDraft((prev) => applyToDraft(prev, input));
          return;
        }
      }
      // Herdr preserves all modifier bits in the keyboard protocol requested by the program in
      // this pane. herdr's attach stream never says that the program asked for application cursor
      // keys (DECCKM), so a terminal's `ESC [ A` misses in less, git log and other full-screen
      // programs. herdr encodes a named key in the program's own mode (#621). A key the socket
      // cannot take now goes the way typing does below, as an arrow always did.
      const arrow = chord === null && !pasting && !composingRef.current && !compositionCommitPendingRef.current && key?.startsWith("Arrow")
        ? terminalChord(key, NO_STICKY_MODIFIERS) : null;
      if (arrow !== null && socket.sendKeys(current, [arrow])) {
        view.key(key!, socket.lastInputSeq(current));
        return;
      }
      if (chord !== null) {
        // Shortcuts are never retained as offline text or replayed later: a chord the
        // terminal cannot take now (not ready, disconnected) is told, not dropped in silence
        if (!socket.sendKeys(current, [chord])) {
          const t = tRef.current; // the language of now, not of the attach
          setInputError(t("Not sent: the terminal is not ready for keys."));
        } else view.key(chord, socket.lastInputSeq(current));
        return;
      }
      if (socket.sendInput(current, input)) {
        // local echo: what typing will show is drawn now, and checked against the bridge's screen
        view.typed(input, socket.lastInputSeq(current));
        return;
      }
      if (secret) {
        const t = tRef.current;
        setInputError(t("Not sent: the terminal is not ready, and a password is never held for later."));
        return;
      }
      if (socket.inputOpening(current)) {
        typeahead ??= { pane: current, inputs: [], timer: window.setTimeout(settleTypeahead, TYPEAHEAD_MS) };
        typeahead.inputs.push(input);
        return;
      }
      // A closed socket, an attachment refused, or a failed synchronous send:
      // keep printable input for explicit review, never replay it automatically.
      holdForReview(current, input);
    };

    // Browsers expose dropped files as bytes, not local paths. Save them beside
    // the pane and paste the returned paths; never send Enter with a drop.
    // Batches upload one after another, so overlapping drops paste their paths in the order dropped.
    let fileQueue: Promise<void> = Promise.resolve();
    const uploadFiles = (files: File[]): void => {
      const pane = paneRef.current;
      if (!pane || !socket.connected || term.inputDisabled) return;
      fileQueue = fileQueue.then(() => uploadBatch(pane, files));
    };
    const uploadBatch = async (pane: string, files: File[]): Promise<void> => {
      if (paneRef.current !== pane || !socket.connected || term.inputDisabled) return;
      try {
        // the paths of a batch are pasted together: one file too large and none is uploaded
        for (const file of files) assertAttachable(file);
        const paths: string[] = [];
        for (const file of files) paths.push(await uploadFileRef.current(pane, file));
        // An upload can finish after the user has switched panes or lost input access.
        if (paneRef.current !== pane || !activeRef.current || !socket.connected || term.inputDisabled) return;
        pasteText(paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ");
        if (activeRef.current && !findOpenRef.current) term.focus();
      } catch (error) {
        // a file over the limit already says which file and the limit, in the UI language
        if (paneRef.current === pane) noteClipboard(error instanceof AttachmentTooLargeError ? error.message : plainError(error));
      }
    };
    const onFilePaste = (event: ClipboardEvent): void => {
      // restty pastes text (bracketed when the program asked) itself. A file-only clipboard
      // needs the upload route instead; copied paths must remain native text.
      if (event.clipboardData?.getData("text/plain")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles(files);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer) return;
      if (!event.dataTransfer.types.some((type) => type === "Files" || type === "text/plain")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = term.inputDisabled ? "none" : "copy";
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      if (!event.dataTransfer || !socket.connected || term.inputDisabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        uploadFiles(files);
        return;
      }
      const text = event.dataTransfer.getData("text/plain");
      if (text) {
        pasteText(text);
        if (activeRef.current) term.focus();
      }
    };
    host.addEventListener("paste", onFilePaste, { capture: true });
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    // Dragging a window edge fires this every frame. Each resize of the pty makes herdr
    // reflow the pane and the program in it redraw (Claude Code repaints its whole
    // conversation), so a drag of a long session sent over a hundred resizes and the app
    // lagged: fit once the size has settled.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        // the grid belongs to the pty while observing, and to herdr when fixed: only the view moves
        // (a soft keyboard opening must not leave the prompt under it)
        if (adopted()) {
          panned = false;
          followCursor();
          return;
        }
        // a pane hidden behind its split's sibling, or following the other half, sizes nothing
        if (!sizesPty()) return;
        // the keyboard took the bottom of the screen, not the pane: the grid stays, the view pans
        if (keyboardHolds(false)) return;
        // a fit the keyboard held back re-asserts the grid as it would have (a lens or role return)
        const force = heldForce;
        fitGrid();
        fitted();
        // a window the system moves or resizes in the background fits its own grid only
        const current = paneRef.current;
        if (current && inUse()) socket.resize(current, term.cols, term.rows, force);
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(host);

    // Touch screens never emit wheel events: a single-finger drag on the terminal becomes wheel
    // events, which restty reports to herdr (mouse reporting is on) exactly like a mouse wheel.
    // The text follows the finger, as everywhere on a phone: dragging down brings
    // older lines in. Each event carries the finger's position, since restty reports
    // a wheel at the cell under it (without one, every report said row 1, column 1).
    // restty never sees a finger itself: its press would reach the program as a mouse press with
    // no release. A tap is a click, replayed as the mouse's (forwardClick).
    // An adopted grid has no history to send a wheel to (an observer's reports are dropped, a
    // mirror reports nothing): there the drag pans the mount, both ways, to the cells past its edge.
    // Two fingers pinch the font size: the font follows them locally, and the shared pty resizes once when one lifts.
    let touchX = 0;
    let touchY = 0;
    /** finger travel of this gesture not yet sent as a wheel report */
    let touchPixels = 0;
    let tracking = false;
    let pinch: { first: number; second: number; startSize: number; startDistance: number; size: number } | null = null;
    // from a second finger until every finger lifts: the stroke is a pinch, never a scroll
    let pinchStroke = false;
    let pinchWatchPending = false;
    let pinchStatusFrame: number | null = null;
    const spread = (a: Touch, b: Touch): number => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const hidePinchBadge = (): void => {
      if (pinchBadgeRef.current) pinchBadgeRef.current.hidden = true;
    };
    const applyLiveFont = (size: number): void => {
      if (baseFontRef.current === size) return;
      baseFontRef.current = size;
      term.setFontSize(size);
      if (adopted()) return;
      // a pinch under the keyboard fits what the finger sees: the keyboard going refits the rows
      fitGrid();
      fitted();
    };
    const finishPinch = (save: boolean): void => {
      const finished = pinch;
      if (finished && (!save || finished.size === finished.startSize)) applyLiveFont(finished.startSize);
      pinch = null;
      const current = paneRef.current;
      if (pinchWatchPending && current && releasedRef.current && watchingRef.current) socket.watch(current, term.cols, term.rows);
      pinchWatchPending = false;
      if (finished && save && finished.size !== finished.startSize) {
        // a pinch can end after the pane went behind a sibling of its split: it saves the size, sizing no pty
        if (current && inUse() && !adopted() && sizesPty()) socket.resize(current, term.cols, term.rows, true);
        updateSettings({ terminalFontSize: finished.size });
        // said once, for the size kept: the badge that follows the fingers is not read out
        const t = tRef.current; // the language of now, not of the attach
        if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
        if (pinchStatusRef.current) pinchStatusRef.current.textContent = "";
        pinchStatusFrame = requestAnimationFrame(() => {
          pinchStatusFrame = null;
          if (pinchStatusRef.current) pinchStatusRef.current.textContent = t("Terminal text size {px} px", { px: finished.size });
        });
      }
      hidePinchBadge();
    };
    const claimPinch = (event: Event): void => {
      event.preventDefault();
      // the host listens in the capture phase: nothing under it takes the first finger of a pinch
      event.stopPropagation();
    };
    /** a finger down and not moved yet: lifted so, it is a tap, the mouse's click */
    let tap: { x: number; y: number } | null = null;
    const TAP_SLOP_PX = 8;
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length === 1 && pinchStroke) {
        finishPinch(false);
        pinchStroke = false;
      }
      if (pinchStroke) {
        claimPinch(event);
        return;
      }
      if (event.touches.length >= 2) {
        if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
        pinchStatusFrame = null;
        tracking = false;
        pinchStroke = true;
        claimPinch(event);
        const a = event.touches[0];
        const b = event.touches[1];
        if (event.touches.length !== 2 || !a || !b ||
            !host.contains(a.target as Node) || !host.contains(b.target as Node) ||
            spread(a, b) <= 0) return;
        const startSize = baseFontRef.current;
        pinch = { first: a.identifier, second: b.identifier, startSize, startDistance: spread(a, b), size: startSize };
        if (pinchBadgeRef.current) {
          pinchBadgeRef.current.textContent = `${startSize}px`;
          pinchBadgeRef.current.hidden = false;
        }
        return;
      }
      tracking = event.touches.length === 1;
      touchPixels = 0;
      const first = event.touches[0];
      if (tracking && first) {
        touchX = first.clientX;
        touchY = first.clientY;
      }
      tap = tracking && first ? { x: first.clientX, y: first.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!pinchStroke && event.touches.length > 1) {
        tracking = false;
        pinchStroke = true;
      }
      const moved = event.touches[0];
      if (tap && (!moved || Math.hypot(moved.clientX - tap.x, moved.clientY - tap.y) > TAP_SLOP_PX)) tap = null;
      if (pinchStroke) {
        claimPinch(event);
        if (pinch && event.touches.length === 2) {
          let first: Touch | undefined;
          let second: Touch | undefined;
          for (let i = 0; i < event.touches.length; i++) {
            const touch = event.touches[i]!;
            if (touch.identifier === pinch.first) first = touch;
            if (touch.identifier === pinch.second) second = touch;
          }
          if (first && second) {
            const size = pinchFontSize(pinch.startSize, pinch.startDistance, spread(first, second));
            if (size !== pinch.size) {
              pinch.size = size;
              applyLiveFont(size);
              if (pinchBadgeRef.current) pinchBadgeRef.current.textContent = `${size}px`;
            }
          }
        }
        return;
      }
      if (!tracking || event.touches.length !== 1) return;
      event.preventDefault();
      const first = event.touches[0];
      if (!first) return;
      // finger moving down (y > touchY) shows older lines: a wheel scrolling up, negative deltaY
      const delta = touchY - first.clientY;
      const across = touchX - first.clientX;
      touchX = first.clientX;
      touchY = first.clientY;
      if (adopted()) {
        panned = true;
        host.scrollBy(across, delta);
        return;
      }
      // restty sends herdr one report per wheel event however far it went, and herdr scrolls a
      // few lines per report: one line-mode wheel per that many rows of finger travel keeps a
      // swipe as far as a slow drag, and the text under the finger
      const { steps, rest } = wheelSteps(touchPixels + delta, term.cellSize().height * HERDR_MOUSE_SCROLL_LINES);
      touchPixels = rest;
      sendTouchWheels(steps);
    };
    /** `steps` line-mode wheel reports at the finger, each one herdr scroll step in the sign's direction */
    const sendTouchWheels = (steps: number): void => {
      if (wheelStateRef.current.omoQuestion) {
        lineScroll.current?.(-steps * HERDR_MOUSE_SCROLL_LINES);
        return;
      }
      const target = term.canvas ?? host;
      for (let sent = 0; sent < Math.abs(steps); sent += 1) {
        target.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaY: Math.sign(steps), deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: touchX, clientY: touchY,
        }));
      }
    };
    const onTouchEnd = (event: TouchEvent): void => {
      // a lifted one-finger drag sends what is left once it reaches half a step: a flick shorter
      // than one step still scrolls, and a long drag loses at most half a step at its end
      if (tracking && event.type === "touchend" && !pinchStroke && !adopted()) {
        sendTouchWheels(finalStep(touchPixels, term.cellSize().height * HERDR_MOUSE_SCROLL_LINES));
      }
      // a tap is the program's click where it reads the mouse, and puts the keyboard in the grid
      const tapped = tap;
      tap = null;
      if (tapped && tracking && event.type === "touchend" && !pinchStroke && event.touches.length === 0) {
        if (term.mouseReporting() && !adopted() && paneRef.current) forwardClick({ clientX: tapped.x, clientY: tapped.y }, { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
        if (activeRef.current && !findOpenRef.current) term.focus();
      }
      touchPixels = 0;
      tracking = false;
      if (!pinchStroke) return;
      claimPinch(event);
      if (event.type === "touchcancel" || event.touches.length < 2) finishPinch(event.type === "touchend");
      if (event.touches.length === 0) pinchStroke = false;
    };
    // Safari zooms inside an overflow region (an adopted grid's mount) despite touch-action: none
    const onGesture = (event: Event): void => { event.preventDefault(); };
    // restty never sees a finger (above): its own pointer handling stays the mouse's
    const keepTouchFromRestty = (event: PointerEvent): void => { if (event.pointerType === "touch") event.stopPropagation(); };
    const touchPointerEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;
    for (const type of touchPointerEvents) host.addEventListener(type, keepTouchFromRestty, { capture: true });
    host.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    host.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    host.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
    host.addEventListener("gesturestart", onGesture, { passive: false });
    host.addEventListener("gesturechange", onGesture, { passive: false });

    // The pty is shared per pane: a client on another device (typically a phone)
    // resizes it to its own geometry, and this tab's viewport never changed, so
    // the ResizeObserver above stays silent and the pane is left at the other
    // device's size. Re-assert our geometry whenever the user comes back to this
    // tab: its window takes the focus, or it turns visible with the focus. Observe
    // connections never do this: they own no geometry to re-assert.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || observeRef.current || fixedGridRef.current || !sizesPty() || keyboardHolds(true)) return;
      fitGrid();
      fitted();
      socket.resize(current, term.cols, term.rows, true);
    };
    // herdr holds a pane at the size of a `terminal attach` for as long as one is attached, and its
    // own TUI cannot take it back (0.9.3): this window, left open behind it, kept the pane at the
    // window's size, and the TUI drew it cut off at its split's edge with its bottom rows out of
    // reach. So a tab out of use lets go of its pane: once the last attach ends, herdr gives the
    // pane back to its TUI. The tab attaches again when the user is back. A line the input line
    // is still sending goes out through this tab's attach, so the tab keeps the pane until it has
    // gone; a mirrored pane holds no attach, and a page inside another page (the site's demo) has
    // the focus only while it is clicked into.
    const embedded = window.self !== window.top;
    const queueWaits = (pane: string): boolean => submitRetention?.has(pane) === true;
    let releaseTimer: number | null = null;
    // the release waits for a line still being sent: its end tries it again
    let queueHeld = false;
    const cancelLeave = (): void => {
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      releaseTimer = null;
      queueHeld = false;
    };
    cancelLeaveRef.current = cancelLeave;
    const release = (): void => {
      cancelLeave();
      const current = paneRef.current;
      if (!current || embedded || mirroredRef.current || fixedGridRef.current) return;
      if (cachedRef.current && releasedRef.current) {
        if (watchingRef.current) { socket.unwatch(current); setWatching(false); }
        // Caching stops the watch, but does not turn an away release into a cache-only release.
        return;
      }
      if (releasedRef.current || (!cachedRef.current
        && (!(releaseAwayRef.current || hiddenOnTouch()) || inUse() || endedRef.current))) return;
      if (queueWaits(current)) {
        queueHeld = true;
        return;
      }
      socket.detach(current);
      // The server's detach receipt holds pending input on this still-live PC connection.
      setReleased(true);
      cachedReleaseRef.current = cachedRef.current;
      if (!cachedRef.current) watch(current);
    };
    // the pane's screen starts again from the view, as on a pane switch; the view's first frame is whole
    const watch = (pane: string): void => {
      // Reset in stream order: the attach's earlier writes must not draw over the view.
      view.reset();
      view.invalidate();
      term.reset();
      modifyOtherKeysRef.current = 0;
      setWatching(socket.watch(pane, term.cols, term.rows));
    };
    // keep_size prevents resizing an existing attach, but a fresh sidecar still sizes the pane.
    // The client cannot distinguish those cases atomically, so both watch until the user returns.
    const deferAttach = (pane: string): boolean => {
      deferredAttach = false;
      if (inUse() || embedded || mirroredRef.current || fixedGridRef.current || queueWaits(pane) || !socket.canWatch()) return false;
      cancelLeave();
      deferredAttach = true;
      setReleased(true);
      cachedReleaseRef.current = false;
      // The local roster can arrive before /api/health identifies a mirror. Wait for that
      // identity rather than briefly starting an observer on a PC with no attach sidecar.
      if (!cachedRef.current && mirroredRef.current !== null) watch(pane);
      return true;
    };
    deferAttachRef.current = deferAttach;
    const offBeforeReplay = socket.onBeforeReplay(() => {
      const pane = paneRef.current;
      if (!pane || releasedRef.current) return;
      if (deferAttach(pane)) socket.detach(pane);
    });
    releaseRef.current = () => { if (queueHeld) release(); };
    // a window resized while watched: the view is drawn for a grid, so it starts again at the new one
    const offWatchedResize = term.onResize((cols, rows) => {
      const current = paneRef.current;
      if (!current || !releasedRef.current || !watchingRef.current) return;
      if (pinch) pinchWatchPending = true;
      else socket.watch(current, cols, rows);
    });
    const resume = (): void => {
      if (!presentedRef.current) return;
      deferredAttach = false;
      setReleased(false);
      const current = paneRef.current;
      if (!current) return;
      if (watchingRef.current) {
        socket.unwatch(current);
        setWatching(false);
      }
      // A fresh attach says attach_held again if needed; success does not send attach-resumed.
      setHeld(false);
      // the pane's screen starts again from the new attach, as on a pane switch.
      // A new attach owns a new output lifetime. The server's readiness receipt precedes
      // replay, so a recovering attach will revoke this again before any retained bytes.
      outputRecovering = false;
      // Reset in stream order: the old attach's writes are all drawn already, the new one's follow.
      if (!cachedReleaseRef.current) {
        view.reset();
        view.invalidate();
        term.reset();
        modifyOtherKeysRef.current = 0;
      }
      cachedReleaseRef.current = false;
      setInputReady(false);
      setOutputReady(false);
      if (!observeRef.current && shownRef.current && !keyboardHolds(true)) {
        fitGrid();
        fitted();
      }
      const away = !inUse();
      // under the keyboard the attach adopts the pane's size (keep_size) and the catch-up fit takes it
      socket.attach(current, term.cols, term.rows, away || !shownRef.current || followRef.current || keyboardHeld);
      if (away) leave();
    };
    // Existing attaches keep their grid while away. New connections watch instead, except
    // for queued input, mirrors, embedded pages and bridges without watch support.
    const leave = (): void => {
      if (cachedRef.current) { release(); return; }
      const current = paneRef.current;
      // A visible but unfocused window still shows the terminal and can receive its grid back.
      // Blur changes only reconnect policy; hiding the document also releases its server grid.
      if (current && !observeRef.current && !fixedGridRef.current) socket.keepSize(current, document.visibilityState === "hidden");
      if (releaseAwayRef.current && releaseTimer === null && !releasedRef.current) releaseTimer = window.setTimeout(() => {
        if (paneRef.current === current) release();
      }, RELEASE_AFTER_MS);
      // already put away on a phone (a pane that replaced a closed one while away): let go now
      if (hiddenOnTouch()) release();
    };
    leaveRef.current = leave;
    // The PC's connection stopped on an overload close (4008), or an attach conflicted: attach again
    // in place, as a pane pick does. The attach reconnects, and the connection's open replays every
    // pane this PC has attached; their snapshot clears what is left of the notice.
    const reattach = (): void => {
      if (!presentedRef.current || !paneRef.current) return;
      stalledRef.current = false;
      setOutputError(null);
      setEnded(false);
      resume();
      term.inputDisabled = observeRef.current || heldRef.current;
    };
    reattachRef.current = reattach;
    const back = (): void => {
      if (!presentedRef.current) return;
      cancelLeave();
      // A pane that kept its attach while put away (a line being sent, a mirror) stopped because its
      // frozen page sent no ACKs, not because this device is too slow: coming back attaches again,
      // once. A stop while the page stays in use is final (no reconnect loop).
      if (stalledRef.current && socket.stoppedWhileHidden && inUse()) reattach();
      else if (releasedRef.current) resume();
      else refit();
    };
    presentationRef.current = () => {
      // put away before its input opened: what was typed into it waits for review, not for its return
      if (!presentedRef.current) settleTypeahead();
      if (cachedRef.current) release();
      else if (presentedRef.current && releasedRef.current) {
        if (inUse() || mirroredRef.current) back();
        else if ((cachedReleaseRef.current || deferredAttach && !watchingRef.current) && paneRef.current) {
          if (!deferAttach(paneRef.current)) back();
        }
        else if (paneRef.current && !watchingRef.current) watch(paneRef.current);
      }
    };
    // A phone or tablet put away lets go of the pane at once, whatever the setting: its page can
    // freeze before a timer runs, and its attach would keep herdr's own window at the phone's size.
    const hiddenOnTouch = (): boolean => coarseRef.current && document.visibilityState === "hidden";
    const onVisibility = (): void => {
      if (inUse()) back();
      else {
        leave();
        if (hiddenOnTouch()) release();
      }
    };
    // Another device can size the pty while this window keeps its focus (a phone used beside a
    // PC left in front): no focus event comes back here, so a click or key in this terminal
    // takes the pane back to this window's grid.
    // Only input meant for the terminal itself: a press or key in the find bar or the key bar,
    // a right-click for the pane menu, a held key's repeats or an IME composition
    // must not resize the pty under the other device.
    // A phone's own input paths sit outside the grid (the input line, its Send and Enter, a key the
    // key bar sends, not a press on it), so they call this before they send: the reply is then
    // drawn for the grid that shows it.
    const reassertIfStale = (): void => {
      const shared = sharedGridRef.current;
      if (!shared || releasedRef.current || !inUse()) return;
      if (shared.cols !== term.cols || shared.rows !== term.rows) refit();
    };
    reassertIfStaleRef.current = reassertIfStale;
    const reclaim = (event: Event): void => {
      if (!(event.target instanceof Node) || !term.element.contains(event.target)) return;
      // an IME's first key comes before compositionstart, with isComposing still false (keyCode 229)
      if (event instanceof KeyboardEvent && (event.repeat || event.isComposing || event.keyCode === 229 || composingRef.current || compositionCommitPendingRef.current)) return;
      if (event instanceof PointerEvent && event.button !== 0) return;
      if (releasedRef.current) back();
      else reassertIfStale();
    };
    // a click or a tap is the user here, whatever the window says about its focus
    const onPointer = (event: PointerEvent): void => {
      if (releasedRef.current && stackRef.current?.contains(event.target as Node)) back();
      else reclaim(event);
    };
    window.addEventListener("focus", back);
    window.addEventListener("blur", leave);
    window.addEventListener("pointerdown", onPointer, { capture: true });
    window.addEventListener("keydown", reclaim, { capture: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      term.inputDisabled = true;
      window.clearInterval(poll);
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      host.removeEventListener("touchstart", onTouchStart, { capture: true });
      host.removeEventListener("touchmove", onTouchMove, { capture: true });
      host.removeEventListener("touchend", onTouchEnd, { capture: true });
      host.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      host.removeEventListener("gesturestart", onGesture);
      host.removeEventListener("gesturechange", onGesture);
      finishPinch(false);
      if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
      for (const type of touchPointerEvents) host.removeEventListener(type, keepTouchFromRestty, { capture: true });
      window.removeEventListener("copy", onCopy, true);
      host.removeEventListener("pointerdown", onPointerDown, { capture: true });
      host.removeEventListener("pointermove", onHover);
      host.removeEventListener("pointerup", onPointerRelease, { capture: true });
      window.removeEventListener("pointermove", onPointerMove, { capture: true });
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onBlur);
      stopEdge();
      stopWheel();
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      releaseRef.current = () => {};
      presentationRef.current = () => {};
      leaveRef.current = () => {};
      cancelLeaveRef.current = () => {};
      reattachRef.current = () => {};
      keyboardHoldsRef.current = () => false;
      fittedRef.current = () => {};
      deferAttachRef.current = () => false;
      offBeforeReplay();
      offWatchedResize();
      offReady();
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", leave);
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("keydown", reclaim, { capture: true });
      reassertIfStaleRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of keepTextOn) host.removeEventListener(type, keepText);
      onData = () => undefined;
      onKey = () => true;
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("paste", onFilePaste, { capture: true });
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      offDisconnect();
      if (typeahead !== null) window.clearTimeout(typeahead.timer);
      typeahead = null;
      offViewResize();
      outputListeners.clear();
      view.dispose();
      viewRef.current = null;
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      off();
      if (!machineSessions) session.close();
      host.removeEventListener("compositionstart", compositionStart);
      host.removeEventListener("compositionend", compositionEnd);
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      compositionCommitPendingRef.current = false;
      // A replacement mount must not share its host with the retiring terminal.
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setTerminal(null);
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // the theme follows the settings without a remount
  const ghosttyBackground = useMemo(() => {
    const bg = settings.terminalThemeName === "" ? undefined : terminalColorsTheme(settings.terminalThemeName, terminalTheme(theme, palette)).colors.background;
    return bg ? `rgb(${bg.r}, ${bg.g}, ${bg.b})` : null;
  }, [settings.terminalThemeName, theme, palette]);
  const colors = useMemo(() => terminalColorsTheme(settings.terminalThemeName, terminalTheme(theme, palette)), [settings.terminalThemeName, theme, palette]);
  useEffect(() => {
    termRef.current?.setTheme(colors);
    const displayTheme = terminalDisplayTheme(colors);
    if (paneId && displayTheme) socketRef.current?.setTerminalTheme(paneId, displayTheme);
  }, [colors, paneId]);

  // and the renderer's own settings: shaping across cells, and the GPU interface it draws with
  useEffect(() => { termRef.current?.setLigatures(settings.terminalLigatures); }, [settings.terminalLigatures]);
  useEffect(() => { termRef.current?.setRenderer(settings.terminalRenderer); }, [settings.terminalRenderer]);

  // the font follows too, and a font change moves the grid: a new size is measured at once, a new
  // family once its faces loaded (restty measures the cell from the first face of the list)
  const fontKey = sanitizeFontFamily(terminalFontFamily);
  const appliedFontKey = useRef(fontKey);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let superseded = false;
    const refit = (): void => {
      // a newer font, or an unmounted terminal, took over while the faces loaded
      if (superseded || termRef.current !== term) return;
      if (observeRef.current || fixedGridRef.current || keyboardHoldsRef.current(true)) return;
      fitRef.current?.();
      fittedRef.current();
      // a chosen font loads after every attach: out of use (a reload behind another app), only
      // this grid fits, and the refit takes the pane once the user is here
      const pane = paneRef.current;
      if (pane && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    };
    // a pinch has set and fitted its size already: the setting only follows it
    const sizeChanged = baseFontRef.current !== terminalFontSize;
    baseFontRef.current = terminalFontSize;
    if (appliedFontKey.current !== fontKey) {
      appliedFontKey.current = fontKey;
      void terminalFonts(terminalFontFamily).then((fonts) => superseded ? undefined : term.setFonts(fonts, fontKey)).then(refit);
    } else if (sizeChanged) refit();
    return () => { superseded = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the family is fontKey's
  }, [terminalFontSize, fontKey]);

  // the grid fits once it is laid out, right after the first attach
  useEffect(() => {
    if (observeRef.current || fixedGridRef.current) return;
    // a soft keyboard may be up as the terminal appears: its grid waits for it to go
    if (keyboardHoldsRef.current(true)) return;
    const term = termRef.current;
    fitRef.current?.();
    fittedRef.current();
    // this runs on every load too, right after the attach: out of use (a reload behind another
    // app), only this grid fits, and the refit takes the pane once the user is here
    const pane = paneRef.current;
    if (pane && term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    if (activeRef.current && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) term?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  // a pane not shown draws nothing (its output still goes in)
  useEffect(() => { termRef.current?.setDrawing(shown); }, [shown]);

  // hidden behind another pane of its split, the pane keeps the size the pty has; shown again, it
  // fits this screen and takes the pty
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current === shown) return;
    wasShown.current = shown;
    const pane = paneRef.current;
    if (!pane || observeRef.current || fixedGridRef.current) return;
    if (!shown) { socketRef.current?.keepSize(pane); return; }
    if (keyboardHoldsRef.current(true)) return;
    const term = termRef.current;
    fitRef.current?.();
    fittedRef.current();
    if (term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [shown]);

  // the split's other half took this tab's grid: this half lets the pty go and draws it at that grid;
  // made the active half, it fits its own screen and takes the pty, as a pane shown again does
  const wasFollowing = useRef(follow);
  useEffect(() => {
    if (wasFollowing.current === follow) return;
    wasFollowing.current = follow;
    const pane = paneRef.current;
    const term = termRef.current;
    if (!pane || !term || observeRef.current || fixedGridRef.current) return;
    if (follow) {
      socketRef.current?.keepSize(pane);
      const shared = sharedGridRef.current;
      if (shared && (term.cols !== shared.cols || term.rows !== shared.rows)) term.resize(shared.cols, shared.rows);
      followCursorRef.current();
      return;
    }
    followCursorRef.current();
    if (keyboardHoldsRef.current(true)) return;
    fitRef.current?.();
    fittedRef.current();
    if (sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [follow]);

  // Reset on a pane or terminal replacement: a herdr restart can keep the pane ID.
  // Old composition timers must never see the new terminal.
  useLayoutEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setInputReady(false);
    setInputError(null);
    setComposing(false);
    setOutputReady(false);
    setOutputError(null);
    stalledRef.current = false;
    setHeld(false);
    setUnsupported(false);
    fixedGridRef.current = false;
    sharedGridRef.current = null;
    // the next pane's grid is this browser's again unless it says otherwise (pane-geometry)
    hostRef.current?.toggleAttribute("data-adopted-grid", observeRef.current);
    secretRef.current = null;
    setSecret(null);
    term.inputDisabled = observeRef.current;
    // a record past its TTL, an undated one, and a hand-edited one all restore as nothing held
    let saved = EMPTY_DRAFT;
    try {
      saved = paneId ? restoreDraft(localStorage.getItem(`t-rex:terminal-draft:${paneStorageId(machineId, paneId)}`), Date.now()) : EMPTY_DRAFT;
    } catch {}
    setDraft(saved);
    draftPaneRef.current = paneId;
    term.reset();
    viewRef.current?.reset();
    viewRef.current?.invalidate();
    modifyOtherKeysRef.current = 0;
    if (!paneId) return;
    const leavePane = (): void => {
      cancelLeaveRef.current();
      // a released pane was detached already
      if (!releasedRef.current) socket.detach(paneId);
      if (watchingRef.current) {
        socket.unwatch(paneId);
        setWatching(false);
      }
      // Keep connection proof until the server confirms the detach as held.
    };
    // A fresh background pane must not acquire size ownership even with the release setting off.
    // This also covers a replacement pane: no prior release or input ownership is inherited.
    setReleased(false);
    // A restored terminal in a cached tab waits until that tab is presented again.
    if (cachedRef.current) {
      setReleased(true);
      return leavePane;
    }
    if (deferAttachRef.current(paneId)) return leavePane;
    // under the keyboard (a pane picked while typing) the fit waits for it to go, and the attach adopts
    // the pane's size meanwhile
    const held = keyboardHoldsRef.current(true);
    if (!held) {
      fit?.();
      fittedRef.current();
    }
    // A pane exempt from watching still asks to keep an existing attachment's size while away.
    const away = !inUse();
    socket.attach(paneId, term.cols, term.rows, away || !shownRef.current || followRef.current || held);
    // no blur or hidden comes for a tab already out of use: it lets go of this pane after a moment too
    if (away) leaveRef.current();
    if (activeRef.current && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) term.focus();
    return leavePane;
  }, [paneId, terminalId]);

  useEffect(() => { presentationRef.current(); }, [cached, presented, mirrored]);


  // A sibling already mounted in the split canvas becomes the keyboard target only on an
  // explicit navigation. Clicking inside it leaves focus on the actual clicked control.
  // The open pane picked again (its sidebar row, its tab) takes back the keyboard they took.
  useEffect(() => {
    if (active && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) termRef.current?.focus();
  }, [active, autoSelected, focusRequest]);

  // the user picked the pane App had switched to on its own (the same row again, which
  // changes nothing): the grid takes the keyboard now
  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (activeRef.current && wasAuto && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) termRef.current?.focus();
  }, [autoSelected]);

  // key-bar taps go through the terminal's input so the onData -> socket path above is reused
  const pressKey = useCallback((item: KeyBarKeyItem) => {
    const term = termRef.current;
    if (!term) return;
    if (composingRef.current || compositionCommitPendingRef.current) return;
    const active = item.modifiers ?? modifiersRef.current;
    // A saved combination is exact; an ordinary key inherits the held modifiers.
    // The built-in interrupt remains its dedicated Ctrl+C action.
    const modified = (item.key !== "ctrl-c" || item.modifiers !== undefined) && (hasModifiers(active) || item.modifiers !== undefined);
    const chord = modified ? terminalChord(item.key, active) : null;
    const input = (modified ? navigationSequence(item.key, active) : null)
      ?? keyBarInputSequence(item.key, viewRef.current?.screen?.modes.cursorKeys ?? false);
    if (input === null) return;
    reassertIfStaleRef.current();
    barKeyRef.current = { key: item.key, chord };
    try { term.input(input); } finally { barKeyRef.current = null; }
    // with the input line, the keyboard belongs to it: a key tap must not move it to the grid
    if (!inputLineRef.current) term.focus();
  }, []);

  const toggleModifier = useCallback((modifier: keyof StickyModifiers) => {
    if (composingRef.current) return;
    const next = { ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] };
    modifiersRef.current = next;
    setModifiers(next);
    if (!inputLineRef.current) termRef.current?.focus();
  }, []);


  // ask the server for the role change; the role-ack handler applies the local
  // consequences (stdin gate, grid adoption or reclamation) once it is confirmed.
  // The initial default is skipped: the server already treats fresh connections as interact.
  const lastSentRole = useRef<ClientRole>(role);
  useEffect(() => {
    if (role === lastSentRole.current) return;
    lastSentRole.current = role;
    socketRef.current?.setMode(role);
  }, [role]);

  const sendDraft = useCallback(() => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || !pane || draft.text.length === 0 || !socket.connected || secretRef.current !== null || heldRef.current) return;
    // a frame the socket refuses (input not ready yet) keeps the draft, on screen and on disk, for
    // another try or Discard; it is never queued
    if (socket.sendInput(pane, draft.text)) setDraft(EMPTY_DRAFT);
  }, [draft]);

  const discardDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  // the terminal's input line: the text typed like the keyboard would, into an agent's open
  // menu too, then Enter after the server's gap; several lines go as one paste
  const sendTerminalLine = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null) return false;
    // its text and Enter would land beside the held draft: Send or Discard that first
    if (draftHeldForRef.current === pane) return Promise.resolve(tRef.current("Not sent: send or discard the held input first."));
    const message = composerMessage(text);
    const payload = message.includes("\n") ? composerPayload(text, viewRef.current?.screen?.modes.bracketedPaste ?? false) : message;
    reassertIfStaleRef.current();
    const sent = socket.submit(pane, message, payload, true);
    if (sent === null) return false;
    const releaseSubmit = submitRetention?.retain(pane);
    return sent.then((result) => (result.ok ? true : submitNote(result.code, result.message))).finally(() => {
      releaseSubmit?.();
      if (paneRef.current === pane && socketRef.current === socket) releaseRef.current();
    });
  }, [submitRetention]);

  // a tap into the input line is the user here: the grid is theirs again before they type
  const reassertGrid = useCallback(() => { reassertIfStaleRef.current(); }, []);

  const pressEnter = useCallback((): boolean | string => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || pane === null || !socket.connected) return false;
    // Enter beside a held draft would run the pty's line without the held start
    if (draftHeldForRef.current === pane) return tRef.current("Not sent: send or discard the held input first.");
    reassertIfStaleRef.current();
    const sent = hasModifiers(modifiersRef.current)
      ? socket.sendKeys(pane, [terminalChord("Enter", modifiersRef.current)!]) : socket.sendInput(pane, "\r");
    return sent;
  }, []);

  const toggleDirect = useCallback(() => {
    if (composingRef.current || lineComposingRef.current) return;
    updateSettings({ terminalInputMode: directTyping ? "line" : "direct" });
  }, [directTyping, updateSettings]);

  // the input line keeps a tapped grid from raising the keyboard; typing straight into it gives it
  // back. Only turning direct typing on raises it: a pane picked with it on does not.
  const directTypingRef = useRef(directTyping);
  useEffect(() => {
    const turnedOn = directTyping && !directTypingRef.current;
    directTypingRef.current = directTyping;
    const textarea = termRef.current?.textarea;
    if (!textarea) return;
    if (inputLine) {
      textarea.setAttribute("inputmode", "none");
      if (document.activeElement === textarea) textarea.blur();
    } else {
      textarea.removeAttribute("inputmode");
      // only the selected pane: a focused sibling would take the selection (PaneCanvas onFocusCapture)
      if (activeRef.current && coarse && turnedOn) termRef.current?.focus();
    }
  }, [inputLine, coarse, directTyping, paneId]);

  const sendApplicationPage = useCallback((direction: -1 | 1) => {
    const pane = paneRef.current, socket = socketRef.current;
    if (!pane || !socket?.connected || !activeRef.current || !presentedRef.current || modalOpen()
        || observeRef.current || heldRef.current || endedRef.current || releasedRef.current || secretRef.current !== null
        || composingRef.current || compositionCommitPendingRef.current) return;
    // An explicit page action follows the program's own history when herdr has none.
    // The live input lease refuses an unready pane and never queues this key for later.
    socket.sendInput(pane, direction < 0 ? "\x1b[5~" : "\x1b[6~");
  }, []);

  useLayoutEffect(() => {
    if (!controls || !active || !paneId) return;
    const current: PaneControls = {
      focusInput: () => {
        if (!activeRef.current || !presentedRef.current || modalOpen() || observeRef.current) return;
        const stack = stackRef.current;
        const secret = stack?.querySelector<HTMLInputElement>(".secret-input input");
        if (secret) { secret.focus({ preventScroll: true }); return; }
        const input = stack?.querySelector<HTMLTextAreaElement>(".terminal-input-text");
        if (input) input.focus({ preventScroll: true });
        else if (!heldRef.current && !endedRef.current) termRef.current?.focus();
      },
      scrollPage: (direction) => {
        if (activeRef.current && presentedRef.current && !modalOpen()) pageScroll.current?.(direction);
      },
    };
    controls.current = current;
    return () => { if (controls.current === current) controls.current = null; };
  }, [controls, active, paneId]);

  const secretInput = presented && paneId !== null && secretActive && !observing && !ended && connected && outputReady ? <SecretInput
    key={`${paneId}:${secret.prompt}`} prompt={secret.prompt} active={active}
    onSend={(value) => socketRef.current?.sendSecret(paneId, secret.prompt, value) ?? null}
    onCancel={() => { if (socketRef.current?.connected) socketRef.current.sendInput(paneId, "\u0003"); }}
  /> : null;
  // the input line's row, kept while the masked input stands in for it
  const lineSlot = presented && paneId !== null && !observing && !ended && inputLine;
  // What floats from the slot may reach up to the grid's top and no further (TerminalInput.css):
  // in a short pane (a split, a phone in landscape with its keyboard up) a grown line or the masked
  // input would otherwise cover the find bar, or be clipped under the pane's frame
  const [inputSlot, setInputSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const surface = stackRef.current?.querySelector(".terminal-surface");
    if (!stackRef.current || !surface || !inputSlot) return;
    const measure = () => {
      const slot = inputSlot.getBoundingClientRect();
      // a box-less slot (the masked input alone) has no rect, and nothing floats there to cap
      if (slot.width === 0) return;
      const room = slot.bottom - surface.getBoundingClientRect().top;
      inputSlot.style.setProperty("--terminal-input-room", `${Math.max(0, Math.floor(room))}px`);
    };
    measure();
    // the surface moves with the find bar and resizes with the stack and the key bar under it
    const observer = new ResizeObserver(measure);
    observer.observe(stackRef.current);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [inputSlot]);

  // the wait for input is a live region in the banner column from the stack's first render, clipped while
  // empty (never display: none); its words land a frame after it (lib/useAnnouncedText.ts). Only a
  // selected pane waits: with none there is no terminal whose input could become ready
  const waitingWords = useAnnouncedText(paneId !== null && !observing && connected && !inputReady && !held && !ended && !released ? t("Waiting for terminal input…") : null);

  return (
    // data-direct-typing: the terminal's own field raises the soft keyboard here (lib/viewport.ts)
    // a Ghostty theme's background reaches past the grid's last cells, as the app theme's --term-bg does
    <div ref={stackRef} className="terminal-stack" style={ghosttyBackground === null ? undefined : { "--term-bg": ghosttyBackground } as CSSProperties}
      data-pane-owner={paneId === null ? undefined : paneStorageId(machineId, paneId)} data-direct-typing={coarse && directTyping ? "" : undefined}
      data-pane-content={paneId !== null && active && presented && shown && connected && outputReady && parsedTarget === outputTarget && !held && !ended && !released && !unsupported && !outputError ? presentationKey : undefined}>
      {paneId === null && restoreError !== null && (
        <div className="terminal-placeholder is-restore-error" role="status">
          <div className="terminal-placeholder-inner">
            <TriangleAlert aria-hidden="true" />
            <span>{t("herdr could not restore this pane")}</span>
            <span className="terminal-placeholder-detail">{restoreError}</span>
          </div>
        </div>
      )}
      {paneId === null && restoreError === null && (
        <div className="terminal-placeholder">
          <div className="terminal-placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15h4.5" />
            </svg>
            <span>{t("Select a pane to open its terminal")}</span>
          </div>
        </div>
      )}
      <div className="terminal-banners">
        {paneId !== null && held && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            <span>{t("Another app has this pane open. It connects here as soon as that app lets go.")}</span>
            {!observing && socketRef.current?.canTakeOver() && (
              <button type="button" className="btn terminal-banner-action" title={t("Take this pane from another web app or terminal attach. That connection will close.")} onClick={() => { if (paneId !== null) socketRef.current?.takeOver(paneId); }}>{t("Open here")}</button>
            )}
          </div>
        )}
        {paneId !== null && unsupported && (
          <div className="terminal-banner terminal-banner-soon" role="status">
            <span>{t("Live terminal is coming to Windows PCs: herdr cannot attach a terminal there yet.")}</span>
          </div>
        )}
        {paneId !== null && outputError && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <button type="button" className="btn" onClick={() => reattachRef.current()}>{t("Reconnect")}</button>
          </div>
        )}
        {inputError && <div className="terminal-banner" role="status">{inputError}<button type="button" className="btn terminal-banner-action" onClick={() => setInputError(null)}>{t("Dismiss")}</button></div>}
        <div className={waitingWords === null ? "visually-hidden" : "terminal-banner"} role="status">{waitingWords}</div>
        {paneId !== null && released && <div className="terminal-banner" role="status">{t(watching ? "View only while you use another window · click to type" : "Paused while you use another window")}</div>}
        {paneId !== null && ended && !outputError && (
          <div className="terminal-banner" role="status">
            {t("Terminal ended")}
          </div>
        )}
        {paneId !== null && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            {t(connectedBefore ? "Reconnecting to T-Rex…" : "Connecting to T-Rex…")}
            {/* one line, cut with an ellipsis: a command is never broken inside a word; the title holds it whole */}
            {draft.text.length > 0 && <span className="draft-held" title={draft.text}> {t("Input held:")} <code>“{draft.text}”</code></span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            {/* on screen the row is its parts, the command and its two controls; the words are for the live region */}
            <span className="visually-hidden">{t("Input held:")}</span>
            {draft.text.length > 0 && <code className="draft-text" title={draft.text}>{draft.text}</code>}
            <span className="draft-actions">
              <button type="button" className="icon-button draft-send" aria-label={t("Send held input")} title={t("Send held input")} disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}>
                <SendHorizontal aria-hidden="true" />
              </button>
              <button type="button" className="icon-button draft-discard" aria-label={t("Discard held input")} title={t("Discard held input")} onClick={discardDraft}>
                <Trash2 aria-hidden="true" />
              </button>
            </span>
            {/* said only when it applies, on a line under the row. The preview shows the start of the
                text: without this, a draft that lost its end looks whole */}
            {draft.truncated && <span className="draft-truncated">{t("Some input could not be held and was left out.")}</span>}
            {/* Enter is never held: without this, two commands look like one line and a paste looks whole */}
            {draft.leftOut && <span className="draft-truncated">{t("An Enter or line break was left out: Send never presses Enter.")}</span>}
          </div>
        )}
        {paneId !== null && !ended && observing && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            <Eye aria-hidden="true" />
            {t("View only")}
          </div>
        )}
        {clipboardNote && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      {presented && findOpen && paneId !== null && (
        <FindBar key={paneId} paneId={paneId} viewportIntent={viewportIntent} onResult={setSearchState} activePane={active} focusRequest={findRequest} disabled={!connected || held || ended || released || !outputReady}
          onClose={() => { setFindOpen(false); if (activeRef.current && !coarse) termRef.current?.focus(); }} />
      )}
      <div className="terminal-surface">
        {/* the grid is a canvas, which assistive technology cannot read, so the region around the
            visible grid carries the pane's name: a screen reader announces which pane
            this is. No tabIndex: the terminal's own field takes the keyboard here on attach, so a
            stop on the wrapper would only be an empty one ahead of it. */}
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} role="region" aria-roledescription={t("Terminal")} aria-label={terminalName} />
        <span className="terminal-font-size" ref={pinchBadgeRef} hidden aria-hidden="true" />
        <span className="visually-hidden" ref={pinchStatusRef} aria-live="polite" />
        {paneId !== null && <TerminalViewportTools key={paneId} viewportIntent={viewportIntent} terminal={terminal} paneId={paneId}
          pageScroll={pageScroll}
          lineScroll={lineScroll}
          onApplicationPage={sendApplicationPage}
          enabled={presented && connected && outputReady && !held && !ended && !released && !unsupported}
          interactive={!observing && !secretActive && !viewportSearching} search={searchState} onError={setInputError} />}
      </div>
      {/* The input line and the masked input float over the grid's last rows from a slot that keeps
          one row's height in flow: a line that grows while it is typed, a note under it or the masked
          input taking its place would otherwise take rows from the grid, and each change of its
          height resizes the shared pty. Without the line (typing straight into the grid) the masked
          input sits in a box-less slot (TerminalInput.css) */}
      {(lineSlot || secretInput) && <div ref={setInputSlot} className={`terminal-input-slot${lineSlot ? "" : " is-empty"}`}>
        {secretInput ?? (lineSlot && !secretActive && <TerminalInput key={paneId} owner={paneStorageId(machineId, paneId)} onComposing={setLineComposing} connected={connected && !held} onSend={sendTerminalLine} onEnter={pressEnter} onFocus={reassertGrid} />)}
      </div>}
      {presented && paneId !== null && !secretActive && !observing && <KeyBar disabled={composing || !connected || !inputReady || held || ended} onKey={pressKey}
        holdScope={`${paneStorageId(machineId, paneId)}:terminal`}
        modifiers={modifiers} onToggleModifier={toggleModifier} items={settings.keyBarItems}
        {...(coarse ? { directTyping, onToggleDirect: toggleDirect, directDisabled: lineComposing } : {})} />}
    </div>
  );
}
