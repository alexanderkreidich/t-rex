import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Bell, Check, ChevronRight, Info, Keyboard, Monitor, Palette, Plug, Search, Smartphone, SquareTerminal, Star, X, type LucideIcon } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { SHORTCUTS, bindingDisplayKeys, formatKeys, isMacPlatform, setShortcutRecording, shortcutDisplayKeys, shortcutKeys, shortcutConflict, type ShortcutId } from "../lib/shortcuts.ts";
import { MENU_SHORTCUT_KEYS, recordShortcut, shortcutMatchesQuery } from "../lib/shortcutRecorder.ts";
import { exactChordRisk, isReservedShortcutKey, parseExactChord } from "../lib/shortcutBindings.ts";
import { CLAUDE_LAUNCH_MODES, CODEX_LAUNCH_MODES, type ClaudeLaunchMode, type CodexLaunchMode } from "../lib/agentLaunchMode.ts";
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, TERMINAL_WHEEL_SPEED_MAX, TERMINAL_WHEEL_SPEED_MIN, useSettings, uiFontSize, type TerminalRenderer } from "../lib/settings.ts";
import { ghosttyThemeNames } from "../lib/restty/theme.ts";
import { pickTheme, rowFor, THEME_IDS, type Mode, type ThemeId } from "../lib/themes.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { KeyBarSettings } from "./KeyBarSettings.tsx";
import { onSettingsHistory, recordSettings, settingsEntry, settingsLevels, type SettingsLevel } from "../lib/settingsHistory.ts";
import { Segmented, SettingsGroup, SettingsRow, Stepper, Toggle } from "./SettingsControls.tsx";
import { FONT_FAMILY_MAX_CHARS, sanitizeFontFamily } from "../lib/fontFamily.ts";
import { UI_FONT_MAX, UI_FONT_MIN } from "../lib/typography.ts";
import { canListInstalledFonts, filterFamilies, isMonospaceFamily, queryInstalledFonts } from "../lib/installedFonts.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { UserError } from "../lib/userError.ts";
import type { MachineSettings } from "../../shared/machines.ts";
import { fetchRemoteAccess, machineRequest } from "../lib/api.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import type { AgentIntegration, HealthAuth, PluginActions, RemoteAccess } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { loadIntegrations, outcomeFor, type IntegrationsResult } from "../lib/integrations.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { copyText } from "../lib/clipboard.ts";
import { PushTestControls } from "./PushTestControls.tsx";
import { HerdrUpdateControls, UpdateControls } from "./UpdateControls.tsx";
import { useSheetSwipe } from "../lib/sheets.ts";
import { CrashProbe, RegionCrash } from "./AppCrash.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { requestedSettingsPage, requestSettingsPage, type SettingsPageId } from "../lib/paletteSettings.ts";

export interface SettingsDialogProps {
  open: boolean;
  /** the section to open on, for a button that points at it; the top otherwise */
  section?: "updates" | null;
  /** the page a link to Settings names (`?settings=`, lib/deepLink.ts), for this opening alone */
  linkPage?: string | null;
  /** the group on that page a link names (`&section=`): it is scrolled to and focused, as Updates is */
  linkSection?: string | null;
  /** the page shown, for the address; null while a phone shows its list of pages */
  onPage?: (page: string | null) => void;
  onClose: () => void;
  /** Account login runs on this server's PC, even while another PC is selected. */
  actions: AppActions;
  updates: UpdatesModel;
  /** how this browser got in, from the last health check */
  auth: HealthAuth | null;
  /** the herdr this app's server talks to, from the last health check */
  herdrVersion: string | null;
  onEnableNotifications: () => Promise<boolean>;
  /** the last change the server refused to save (lib/preferencesSync.ts); null once a save lands */
  saveError: UserError | null;
  /** a file preview is open beneath: the dialog is drawn above it */
  overPreview?: boolean;
}

function compactKeys(keys: readonly string[]): string {
  return formatKeys(keys).map((key) => ({ Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] ?? (key.length === 1 ? key.toUpperCase() : key))).join("+");
}

/** The key of a Mod+Shift binding as shown: the reservations isReservedShortcutKey knows are Mod+Shift ones, not ⌘B's. */
function modShiftKey(keys: readonly string[]): string | undefined {
  return keys[0] === "Mod" && keys[1] === "Shift" ? keys[2] : undefined;
}

const FONT_LIST_LIMIT = 150;
const FONT_FAMILY_PLACEHOLDER = 'D2Coding, "Cascadia Mono"';

/**
 * A font family list, saved when the field is left, on Enter or when the dialog closes: saving
 * every keystroke would sanitize away the comma or space being typed, and each change of the
 * terminal's font refits the grid and resizes the pane.
 */
function FontFamilyInput({ value, label, onCommit, fixedWidthFor = null }: { value: string; label: string; onCommit: (family: string) => void; /** the surface that needs every glyph on one advance: a proportional pick from the list is refused in its name */ fixedWidthFor?: "terminal" | null }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  // closing the dialog with Escape unmounts the field without a blur
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  const [families, setFamilies] = useState<string[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  // the click is the gesture the permission prompt needs; where the API is missing there is no button
  const browse = async (): Promise<void> => {
    if (browsing) {
      setBrowsing(false);
      return;
    }
    setRefused("");
    setQuery("");
    if (families === null) {
      const result = await queryInstalledFonts();
      if (result.status !== "granted") {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setFamilies(result.families);
    }
    setBrowsing(true);
  };
  const matches = useMemo(() => filterFamilies(families ?? [], query), [families, query]);
  const pick = (family: string): void => {
    if (fixedWidthFor !== null && !isMonospaceFamily(family)) {
      setRefused(family);
      return;
    }
    const next = sanitizeFontFamily(family);
    setDraft(next);
    setBrowsing(false);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="settings-font-field">
      <div className="settings-font-line">
        <input
          className="input settings-font-input"
          value={draft}
          placeholder={FONT_FAMILY_PLACEHOLDER}
          maxLength={FONT_FAMILY_MAX_CHARS}
          aria-label={label}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // an IME keeps its Enter, including the committing one WebKit can send after compositionend as key code 229
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            commit();
          }}
        />
        {canListInstalledFonts() && (
          <button type="button" className="btn settings-font-browse" aria-expanded={browsing} aria-label={t("Browse installed fonts for {label}", { label })} onClick={() => void browse()}>
            <Search aria-hidden="true" />
            {t("Browse")}
          </button>
        )}
      </div>
      {unavailable && <p className="settings-font-note" role="status">{t("Installed fonts could not be listed. Type the name instead.")}</p>}
      {browsing && families !== null && (
        <div className="settings-font-picker">
          <input
            className="input settings-font-search"
            type="search"
            value={query}
            placeholder={t("Search fonts")}
            aria-label={t("Search fonts")}
            spellCheck={false}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                // closes the list, not the dialog behind it
                event.stopPropagation();
                setBrowsing(false);
              }
            }}
          />
          {refused !== "" && <p className="settings-font-note" role="status">{t("{font} is not monospace. The terminal needs a fixed-width font, so the current font was kept.", { font: refused })}</p>}
          <ul className="settings-font-list" aria-label={t("Installed fonts")}>
            {matches.slice(0, FONT_LIST_LIMIT).map((family) => (
              <li key={family}>
                <button type="button" className="settings-font-option" style={{ fontFamily: `"${family}", var(--font-ui)` }} onClick={() => pick(family)}>
                  {family}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="settings-font-empty">{t("No fonts found")}</li>}
          </ul>
          {matches.length > FONT_LIST_LIMIT && <p className="settings-font-note">{t("Showing the first {count} fonts. Search to narrow the list.", { count: FONT_LIST_LIMIT })}</p>}
        </div>
      )}
    </div>
  );
}


type SettingsPage = SettingsPageId;

/** The pages in the order the list shows them: what is looked at first, then what is set once. */
export const PAGES: readonly { id: SettingsPage; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "terminal", icon: SquareTerminal },
  { id: "alerts", icon: Bell },
  { id: "shortcuts", icon: Keyboard },
  { id: "devices", icon: Smartphone },
  { id: "remote", icon: Monitor },
  { id: "integrations", icon: Plug },
  { id: "about", icon: Info },
];

/** The sheet's own breakpoint (`.modal`, styles.css): under it the list and a page take turns. */
const NARROW_QUERY = "(max-width: 640px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_QUERY);
    if (!media) return;
    const refresh = () => setNarrow(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, []);
  return narrow;
}

/** What a Settings entry of the history shows, when it names a page this version has. */
function shownBy(entry: SettingsLevel | null): { page: SettingsPage | null; keyBar: boolean } | null {
  if (entry === null) return null;
  const page = PAGES.find(({ id }) => id === entry.page)?.id ?? null;
  return page === null && entry.page !== null ? null : { page, keyBar: entry.keyBar && page === "terminal" };
}

/** What each theme is called: the color words are translated, the brand names stay as their projects write them. */
const THEME_NAMES: Record<ThemeId, string> = {
  amber: "Amber",
  charcoal: "Charcoal",
  codex: "Codex",
  catppuccin: "Catppuccin",
  "catppuccin-latte": "Catppuccin Latte",
  "tokyo-night": "Tokyo Night",
  "tokyo-night-day": "Tokyo Night Day",
  gruvbox: "Gruvbox",
  "gruvbox-light": "Gruvbox Light",
  "one-dark": "One Dark",
  "one-light": "One Light",
  solarized: "Solarized",
  "solarized-light": "Solarized Light",
  kanagawa: "Kanagawa",
  "kanagawa-lotus": "Kanagawa Lotus",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  dracula: "Dracula",
  nord: "Nord",
  vesper: "Vesper",
};

/**
 * Every theme, grouped by the kind of the row `side` draws it with - a both-mode theme by the
 * side's own kind, a single-kind theme by its only one - the side's own kind first. The other
 * kind is offered too: a dark theme chosen for light mode draws dark, as it does in herdr.
 */
function themeGroups(side: Mode): { kind: Mode; ids: ThemeId[] }[] {
  const other: Mode = side === "dark" ? "light" : "dark";
  return [side, other].map((kind) => ({ kind, ids: THEME_IDS.filter((id) => rowFor(id, side).mode === kind) }));
}

/** The theme of one side. Picking a paired theme also fills the other side with its sibling while that side is still untouched (pickTheme). */
function ThemeSelect({ side }: { side: Mode }) {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <select id={`settings-theme-${side}`} className="select settings-select" value={side === "dark" ? settings.darkTheme : settings.lightTheme} onChange={(event) => update(pickTheme(settings, side, event.target.value as ThemeId))}>
      {themeGroups(side).map(({ kind, ids }) => (
        <optgroup key={kind} label={kind === "dark" ? t("Dark") : t("Light")}>
          {ids.map((id) => <option key={id} value={id}>{t(THEME_NAMES[id])}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** The terminal's colours: the app theme's, or one of Ghostty's (restty's built-in set). */
function TerminalThemeSelect() {
  const { settings, update } = useSettings();
  const t = useT();
  const names = useMemo(ghosttyThemeNames, []);
  return (
    <select id="settings-terminal-theme" className="select settings-select" value={names.includes(settings.terminalThemeName) ? settings.terminalThemeName : ""} onChange={(event) => update({ terminalThemeName: event.target.value })}>
      <option value="">{t("Match the app")}</option>
      <optgroup label={t("Ghostty themes")}>
        {names.map((name) => <option key={name} value={name}>{name}</option>)}
      </optgroup>
    </select>
  );
}

function AppearancePage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <>
    <SettingsGroup>
      <SettingsRow label={t("Theme")} wide>
        <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }, { value: "system", label: t("System") }]} />
      </SettingsRow>
      <SettingsRow label={t("Dark theme")} description={t("Shown in dark mode")} htmlFor="settings-theme-dark" wide>
        <ThemeSelect side="dark" />
      </SettingsRow>
      <SettingsRow label={t("Light theme")} description={t("Shown in light mode")} htmlFor="settings-theme-light" wide>
        <ThemeSelect side="light" />
      </SettingsRow>
      <SettingsRow label={t("Density")}>
        <Segmented label={t("Density")} value={settings.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]} />
      </SettingsRow>
      <SettingsRow label={t("Language")} description={t("Follows the browser unless you choose one")} htmlFor="settings-language">
        <select id="settings-language" className="select settings-select" value={settings.language} onChange={(event) => update({ language: event.target.value as typeof settings.language })}>
          {LANGUAGE_SETTINGS.map((language) => <option key={language} value={language}>{language === "system" ? t("System") : LANGUAGE_NAMES[language]}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("Sidebar rows")} description={t("Name each workspace on one line, or show what its agent is doing with the workspace under it")} wide>
        <Segmented label={t("Sidebar rows")} value={settings.sidebarRows} onChange={(sidebarRows) => update({ sidebarRows })} options={[{ value: "one", label: t("One line") }, { value: "two", label: t("Two lines") }]} />
      </SettingsRow>
      <SettingsRow label={t("Agents order")} description={t("Activity keeps a waiting agent on top, then the one that changed last; herdr's own order is not changed")} wide>
        <Segmented label={t("Agents order")} value={settings.agentOrder} onChange={(agentOrder) => update({ agentOrder })} options={[{ value: "workspace", label: t("Workspaces") }, { value: "activity", label: t("Activity") }]} />
      </SettingsRow>
      <SettingsRow label={t("Agent logos")} description={t("Draw each agent's logo in its brand colors, or without color")} wide>
        <Segmented label={t("Agent logos")} value={settings.agentMarks} onChange={(agentMarks) => update({ agentMarks })} options={[{ value: "color", label: t("Color") }, { value: "mono", label: t("Mono") }]} />
      </SettingsRow>
      <SettingsRow label={t("Status indicators")} description={t("Classic marks only the states that ask for a look; Dots and Symbols draw every state as herdr's TUI does")} wide>
        <Segmented label={t("Status indicators")} value={settings.statusIndicators} onChange={(statusIndicators) => update({ statusIndicators })} options={[{ value: "classic", label: t("Classic") }, { value: "dots", label: t("Dots") }, { value: "symbols", label: t("Symbols") }]} />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Typography")} section="typography">
      <SettingsRow label={t("Interface font size")} description={t("Menus, lists, dialogs and the sidebar. The terminal keeps its own.")}>
        <Stepper label={t("Interface font size")} value={uiFontSize(settings)} text={`${uiFontSize(settings)}px`} min={UI_FONT_MIN} max={UI_FONT_MAX} decreaseLabel={t("Decrease interface font size")} increaseLabel={t("Increase interface font size")} onChange={(size) => update({ uiFontSize: size })} />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Terminal")} section="terminal-look">
      <SettingsRow label={t("Terminal font size")} description={t("Applied to every terminal pane")}>
        <Stepper label={t("Terminal font size")} value={settings.terminalFontSize} text={`${settings.terminalFontSize}px`} min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} decreaseLabel={t("Decrease terminal font size")} increaseLabel={t("Increase terminal font size")} onChange={(terminalFontSize) => update({ terminalFontSize })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal font")} description={t("Installed fonts, comma-separated and tried in order. The browser has to let the app read your fonts (Browse asks); otherwise the terminal keeps JetBrains Mono.")} wide>
        <FontFamilyInput value={settings.terminalFontFamily} label={t("Terminal font")} fixedWidthFor="terminal" onCommit={(terminalFontFamily) => update({ terminalFontFamily })} />
      </SettingsRow>
      <SettingsRow label={t("Ligatures")} description={t("Draws -> != => and the like as one glyph where the font has them")}>
        <Toggle label={t("Ligatures")} checked={settings.terminalLigatures} onChange={(terminalLigatures) => update({ terminalLigatures })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal theme")} description={t("The app's colours, or one of Ghostty's themes")} htmlFor="settings-terminal-theme" wide>
        <TerminalThemeSelect />
      </SettingsRow>
      <SettingsRow label={t("Renderer")} description={t("Auto draws with WebGPU where the browser has it, and with WebGL2 elsewhere")} htmlFor="settings-terminal-renderer">
        <select id="settings-terminal-renderer" className="select settings-select" value={settings.terminalRenderer} onChange={(event) => update({ terminalRenderer: event.target.value as TerminalRenderer })}>
          <option value="auto">{t("Auto")}</option>
          <option value="webgpu">WebGPU</option>
          <option value="webgl2">WebGL2</option>
        </select>
      </SettingsRow>
    </SettingsGroup>
    </>
  );
}

function TerminalPage({ keyBarButtonRef, onEditKeyBar }: { keyBarButtonRef: RefObject<HTMLButtonElement | null>; onEditKeyBar: () => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup>
      <SettingsRow label={t("Wheel scroll speed")} description={t("How far one turn of the wheel scrolls the terminal")}>
        <Stepper label={t("Wheel scroll speed")} value={settings.terminalWheelSpeed} text={`${settings.terminalWheelSpeed}×`} min={TERMINAL_WHEEL_SPEED_MIN} max={TERMINAL_WHEEL_SPEED_MAX} decreaseLabel={t("Slower wheel scrolling")} increaseLabel={t("Faster wheel scrolling")} onChange={(terminalWheelSpeed) => update({ terminalWheelSpeed })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal input mode")} htmlFor="terminal-input-mode">
        {/* "auto", the stored default, types straight into the grid on every device: it reads as Direct typing */}
        <select id="terminal-input-mode" className="select settings-select" value={settings.terminalInputMode === "line" ? "line" : "direct"} onChange={(event) => update({ terminalInputMode: event.target.value as "line" | "direct" })}>
          <option value="direct">{t("Direct typing")}</option><option value="line">{t("Input line")}</option>
        </select>
      </SettingsRow>
      <SettingsRow label={t("Key bar")} description={t("Keys, order and custom combinations for the terminal.")}>
        <button type="button" ref={keyBarButtonRef} className="btn" onClick={onEditKeyBar}>{t("Edit key bar")}</button>
      </SettingsRow>
      <SettingsRow label={t("Clipboard from a pane")} description={t("A program in a pane that copies (vim, tmux, Claude Code) puts its text on this device's clipboard, as a copy you made yourself would. Turn it off if a pane runs output you do not trust: it could replace what you paste next.")}>
        <Toggle label={t("Clipboard from a pane")} checked={settings.paneClipboard} onChange={(paneClipboard) => update({ paneClipboard })} />
      </SettingsRow>
      <SettingsRow label={t("Use alongside herdr's own window")} description={t("Turn this on if this PC also shows herdr in a terminal window. A second after you switch to another window, this tab only watches the pane, so herdr's window keeps the pane at its own size instead of this window's. Click the tab to type again. While it watches, the pane is drawn at herdr's size and may not fill this window.")}>
        <Toggle label={t("Use alongside herdr's own window")} checked={settings.releasePaneAway} onChange={(releasePaneAway) => update({ releasePaneAway })} />
      </SettingsRow>
    </SettingsGroup>
  );
}

function AlertsPage({ onEnableNotifications }: { onEnableNotifications: () => Promise<boolean> }) {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup note={t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}>
      <PushTestControls onEnable={onEnableNotifications} />
      <SettingsRow label={t("Needs input")} description={t("An agent waits for an answer or a permission")}>
        <Toggle label={t("Needs input")} checked={settings.alertInput} onChange={(alertInput) => update({ alertInput })} />
      </SettingsRow>
      <SettingsRow label={t("Finished")} description={t("Long turns: only work that took a minute or more")} wide>
        <Segmented label={t("Finished")} value={settings.alertDone} onChange={(alertDone) => update({ alertDone })} options={[{ value: "off", label: t("Off") }, { value: "long", label: t("Long turns") }, { value: "always", label: t("Every turn") }]} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * herdr's own integrations (`integration.list`), read only: installing one writes into an agent's
 * hooks or settings, which this app leaves to the user, so a row shows the command to run instead.
 */
function IntegrationsPage() {
  return (
    <>
      <LaunchModesGroup />
      <IntegrationsList />
    </>
  );
}

function claudeModeName(mode: ClaudeLaunchMode, t: ReturnType<typeof useT>): string {
  return mode === "acceptEdits" ? t("Accept edits") : mode === "auto" ? t("Auto") : mode === "plan" ? t("Plan")
    : mode === "dontAsk" ? t("Don't ask") : mode === "bypassPermissions" ? t("Bypass permissions") : t("Agent default");
}
function codexModeName(mode: CodexLaunchMode, t: ReturnType<typeof useT>): string {
  return mode === "readOnly" ? t("Read only") : mode === "auto" ? t("Auto") : mode === "fullAccess" ? t("Full access") : t("Agent default");
}

/** The mode the New worktree dialog starts Claude Code and Codex in (lib/agentLaunchMode.ts). */
function LaunchModesGroup() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup title={t("New agents")} section="launch-modes" note={t("Applies to agents started from New worktree. Agent default adds no flag, so the agent's own configuration decides.")}>
      <SettingsRow label="Claude Code" description={t("Permission mode")} htmlFor="settings-claude-launch-mode">
        <select id="settings-claude-launch-mode" className="select settings-select" value={settings.claudeLaunchMode} onChange={(event) => update({ claudeLaunchMode: event.target.value as ClaudeLaunchMode })}>
          {CLAUDE_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{claudeModeName(mode, t)}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label="Codex" description={t("Sandbox and approvals")} htmlFor="settings-codex-launch-mode">
        <select id="settings-codex-launch-mode" className="select settings-select" value={settings.codexLaunchMode} onChange={(event) => update({ codexLaunchMode: event.target.value as CodexLaunchMode })}>
          {CODEX_LAUNCH_MODES.map((mode) => <option key={mode} value={mode}>{codexModeName(mode, t)}</option>)}
        </select>
      </SettingsRow>
    </SettingsGroup>
  );
}

function IntegrationsList() {
  const t = useT();
  const api = useMachineApi();
  const machineId = useMachineId();
  const [result, setResult] = useState<IntegrationsResult | null>(null);
  useEffect(() => {
    let live = true;
    void loadIntegrations(api.fetchIntegrations).then((outcome) => { if (live) setResult({ machineId, outcome }); });
    return () => { live = false; };
  }, [api, machineId]);
  const outcome = outcomeFor(result, machineId);
  const note = t("herdr's integrations let it resume each agent's session after a restart. This page only reads them: run a command in a terminal on the PC herdr runs on, then reopen this page.");
  if (outcome === null) return <SettingsGroup note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  if (outcome.kind === "unsupported") return <SettingsGroup><p className="settings-item settings-hint" role="status">{t("This PC's bridge does not offer agent integrations yet. It will after its next runtime update.")}</p></SettingsGroup>;
  if (outcome.kind === "error") return <SettingsGroup note={note}><p className="settings-item settings-hint" role="alert">{outcome.message}</p></SettingsGroup>;
  const { integrations } = outcome;
  // agents on the PC's PATH first, in herdr's order: the rest can wait until one is installed
  const groups = [
    { title: undefined, rows: integrations.filter((integration) => integration.available) },
    { title: t("Not found on this PC"), rows: integrations.filter((integration) => !integration.available) },
  ].filter((group) => group.rows.length > 0);
  return (
    <>
      {groups.map((group, index) => (
        <SettingsGroup key={group.title ?? "found"} title={group.title} note={index === 0 ? note : undefined}>
          {group.rows.map((integration) => <IntegrationRow key={integration.target} integration={integration} />)}
        </SettingsGroup>
      ))}
    </>
  );
}

function IntegrationRow({ integration }: { integration: AgentIntegration }) {
  const t = useT();
  const commandRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  // the latest Copy owns the label: an earlier press's timer must not clear it early
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const name = integration.label;
  if (integration.state === "current") {
    return (
      <SettingsRow label={name} description={t("Installed")}>
        <Check className="settings-integration-check" aria-hidden="true" />
      </SettingsRow>
    );
  }
  // the label is the name `herdr integration install` takes (antigravity_cli is antigravity-cli)
  const command = `herdr integration install ${name}`;
  const copy = async (): Promise<void> => {
    if (!(await copyText(command, commandRef.current))) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const state = integration.state === "outdated" ? t("Installed, but older than this herdr: run this to update it") : t("Not installed");
  return (
    <SettingsRow label={name} description={<>{state}<code ref={commandRef} className="settings-integration-command">{command}</code></>}>
      <button type="button" className="btn" aria-label={t("Copy the command for {name}", { name })} onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
    </SettingsRow>
  );
}

function ShortcutsPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const platformIsMac = isMacPlatform();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<{ id: ShortcutId; problem: string | null } | null>(null);
  // a recorded chord the terminal or the browser also uses waits here for Save anyway or Cancel
  const [pending, setPending] = useState<{ id: ShortcutId; value: string; risk: "terminal" | "browser" } | null>(null);
  // Save anyway and Cancel leave with the prompt: focus goes back to the row's Record button
  const recordButtons = useRef(new Map<ShortcutId, HTMLButtonElement>());
  const settlePending = (id: ShortcutId): void => {
    setPending(null);
    recordButtons.current.get(id)?.focus();
  };
  const recordingId = recording?.id ?? null;
  const riskText = (risk: "terminal" | "browser", keys: string): string => risk === "terminal"
    ? t("{keys} is a terminal key: shells, editors and agents use it. Once saved, it no longer reaches the pane.", { keys })
    : t("Your browser or operating system may intercept {keys}.", { keys });
  // while a row records, the chord pressed is read here and the app's own dispatcher stands down
  useEffect(() => {
    if (recordingId === null) return;
    setShortcutRecording(true);
    const onKeyDown = (event: KeyboardEvent): void => {
      const result = recordShortcut(event, platformIsMac);
      if (result.kind === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "cancel") return setRecording(null);
      if (result.kind === "invalid") {
        const problem = result.reason === "chord"
          ? (platformIsMac ? t("Hold ⌘, Ctrl or ⌥, with or without Shift, and press a key.") : t("Hold Ctrl or Alt, with or without Shift, and press a key."))
          : result.reason === "key" ? t("That key cannot be a shortcut.") : t("Your browser or operating system keeps that shortcut.");
        return setRecording({ id: recordingId, problem });
      }
      const value = result.kind === "key" ? result.key : result.value;
      if (shortcutConflict(recordingId, [value], settings.shortcutOverrides, platformIsMac)) return setRecording({ id: recordingId, problem: t("Already assigned") });
      setRecording(null);
      if (result.kind === "exact" && result.risk !== null) return setPending({ id: recordingId, value, risk: result.risk });
      update({ shortcutOverrides: { ...settings.shortcutOverrides, [recordingId]: value } });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setShortcutRecording(false);
    };
  }, [recordingId, platformIsMac, settings.shortcutOverrides, update, t]);
  const visible = SHORTCUTS.filter((shortcut) => {
    const keys = shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides);
    return shortcutMatchesQuery(t(shortcut.label), `${formatKeys(keys).join(" ")} ${compactKeys(keys)}`, query);
  });
  return (
    <>
      <input
        type="search"
        className="input settings-shortcut-search"
        value={query}
        placeholder={t("Search shortcuts")}
        aria-label={t("Search shortcuts")}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
      />
      {visible.length === 0 && <p className="settings-hint" role="status">{t("No shortcuts match.")}</p>}
      <SettingsGroup className="settings-shortcuts" section="shortcuts" note={<>{t("Bindings apply to this browser and device. Mod+Shift chords leave the terminal its keys; Record also takes other chords with Ctrl, Alt or (on a Mac) ⌘, exactly as pressed.")} {t("Text selection in focused fields stays native; Tab/list keys are UI-local, not global shortcuts.")} {t("The mobile key bar sends terminal keys, not app actions.")}</>}>
        {visible.map((shortcut) => {
          const displayedKeys = shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides);
          const selectedKey = modShiftKey(displayedKeys);
          const override = Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] : null;
          const exact = override ? parseExactChord(override) : null;
          const selectedRisk = exact ? exactChordRisk(exact, platformIsMac) : selectedKey !== undefined && isReservedShortcutKey(selectedKey, platformIsMac) ? "browser" : null;
          const confirming = pending?.id === shortcut.id ? pending : null;
          const defaultKeys = shortcutDisplayKeys(shortcut.id, {});
          const defaultKey = modShiftKey(defaultKeys);
          const defaultReserved = defaultKey !== undefined && isReservedShortcutKey(defaultKey, platformIsMac);
          // a binding without a default key is off by default: its Default row reads Off, with no second Off
          const unbound = defaultKeys.length === 0;
          const rowText = recording?.id === shortcut.id ? (recording.problem ?? t("Press the new shortcut, or Escape to cancel.")) : confirming ? riskText(confirming.risk, compactKeys(bindingDisplayKeys(confirming.value))) : selectedRisk ? riskText(selectedRisk, compactKeys(displayedKeys)) : undefined;
          return (
            <SettingsRow key={shortcut.id} label={t(shortcut.label)} wide description={rowText === undefined ? undefined : <span role="status">{rowText}</span>}>
                <span className="settings-shortcut-control">
                <button type="button" className="btn settings-shortcut-record" ref={(button) => { if (button) recordButtons.current.set(shortcut.id, button); else recordButtons.current.delete(shortcut.id); }} aria-pressed={recording?.id === shortcut.id} aria-label={t("Record shortcut for {name}", { name: t(shortcut.label) })} onClick={() => { setPending(null); setRecording(recording?.id === shortcut.id ? null : { id: shortcut.id, problem: null }); }}>{recording?.id === shortcut.id ? t("Press keys…") : t("Record")}</button>
                {confirming ? <>
                  <button type="button" className="btn settings-shortcut-confirm" onClick={() => {
                    settlePending(confirming.id);
                    update({ shortcutOverrides: { ...settings.shortcutOverrides, [confirming.id]: confirming.value } });
                  }}>{t("Save anyway")}</button>
                  <button type="button" className="btn" onClick={() => settlePending(confirming.id)}>{t("Cancel")}</button>
                </> : <select className="select settings-select settings-shortcut-select" aria-label={t(shortcut.label)} value={Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] ?? (unbound ? "default" : "off") : "default"} onChange={(event) => {
                  const next = { ...settings.shortcutOverrides };
                  if (event.target.value === "default") delete next[shortcut.id];
                  else next[shortcut.id] = event.target.value === "off" ? null : event.target.value;
                  update({ shortcutOverrides: next });
                }}>
                  <option value="default" title={t("Default")} disabled={shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides)}>{unbound ? t("Off") : compactKeys(defaultKeys)}{defaultReserved ? ` — ${t("Reserved")}` : ""}</option>
                  {!unbound && <option value="off" title={t("Send keys to terminal")}>{t("Off")}</option>}
                  {/* a recorded chord the list below does not offer (exact modifiers, Home, End, punctuation) is listed as itself */}
                  {override && (exact || !MENU_SHORTCUT_KEYS.includes(override)) && <option value={override}>{compactKeys(displayedKeys)}</option>}
                  {MENU_SHORTCUT_KEYS.map((key) => {
                    const conflict = shortcutConflict(shortcut.id, [key], settings.shortcutOverrides);
                    const reserved = isReservedShortcutKey(key, platformIsMac);
                    return <option key={key} value={key} disabled={conflict}>{compactKeys(["Mod", "Shift", key])}{reserved ? ` — ${t("Reserved")}` : ""}{conflict ? " — " + t("Already assigned") : ""}</option>;
                  })}
                </select>}
                </span>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <div className="settings-actions">
        <button type="button" className="btn" onClick={() => {
          setPending(null);
          setRecording(null);
          update({ shortcutOverrides: {} });
        }}>{t("Reset shortcuts")}</button>
      </div>
    </>
  );
}

function DevicesPage({ auth, onSignOut }: { auth: HealthAuth | null; onSignOut: (() => Promise<void>) | null }) {
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  // the server says what Tailscale on its PC already serves
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { loadAccess(); }, [loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, for the pairing QR code: the served address, else this one when it is not loopback
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // what keeps the switch from working here, only while it does (lib/wakeLock.ts asks for the same two)
  const wakeLockProblem = !window.isSecureContext ? t("Needs HTTPS or localhost.") : !("wakeLock" in navigator) ? t("This browser can't keep the screen on.") : null;
  return (
    <>
      <SettingsGroup title={t("Phone")} section="phone">
        <div className="settings-item"><PhonePanel plan={plan} loading={access === undefined} onRefresh={loadAccess} /></div>
        <SettingsRow label={t("Keep screen on")} description={<>{t("While a terminal is open.")}{wakeLockProblem !== null && <span className="settings-condition">{wakeLockProblem}</span>}</>}>
          <Toggle label={t("Keep screen on")} checked={settings.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} />
        </SettingsRow>
        <SettingsRow label={t("Install")} description={installPrompt.installed ? t("Installed") : installPrompt.canInstall ? undefined : installPrompt.help}>
          {!installPrompt.installed && installPrompt.canInstall && <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>}
        </SettingsRow>
      </SettingsGroup>


      <SettingsGroup title={t("Devices")} section="devices">
        <div className="settings-item"><DevicesPanel pairUrl={pairUrl} auth={auth} /></div>
        {onSignOut && (
          <SettingsRow label={t("Sign out")} description={t("Forget this browser's sign-in. Getting back in takes the access token or a pairing code.")}>
            <button type="button" className="btn" onClick={() => setConfirmSignOut(true)}>{t("Sign out")}</button>
          </SettingsRow>
        )}
        {onSignOut && confirmSignOut && (
          <ConfirmDialog title={t("Sign out of this browser?")}
            body={t("Getting back in takes the access token, or a pairing code from the PC: Settings → Phone & devices there, or the pair command in its terminal.")}
            confirmLabel={t("Sign out")} onClose={() => setConfirmSignOut(false)} onConfirm={onSignOut} />
        )}
      </SettingsGroup>
    </>
  );
}

function RemotePcsPage({ actions, pcSettings, pcSettingsError, onPcSettings }: { actions: AppActions; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void }) {
  const t = useT();
  const { settings, update } = useSettings();
  return (
    <SettingsGroup>
      <SettingsRow label={t("Show remote PCs")} description={t("List the PCs you added or saved in herdr in the PC switcher at the top of the sidebar. Off, it lists this PC alone; the others stay set up.")}>
        <Toggle label={t("Show remote PCs")} checked={settings.showRemotePcs} onChange={(showRemotePcs) => update({ showRemotePcs })} />
      </SettingsRow>
      <SettingsRow label={t("Add PC")} description={t("Connect another PC over an SSH alias or user@host. Its workspaces join the sidebar.")}>
        <button type="button" className="btn" onClick={actions.openAddPc}><Monitor aria-hidden="true" />{t("Add PC")}</button>
      </SettingsRow>
      {/* the switch is the server's and waits for its answer; Add PC never does */}
      {pcSettings && (
        <SettingsRow label={t("Update PC bridges automatically")} description={t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}>
          <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => onPcSettings({ auto_update_bridges })} />
        </SettingsRow>
      )}
      {pcSettingsError && <p className="settings-item settings-hint" role="alert">{pcSettingsError}</p>}
    </SettingsGroup>
  );
}

/**
 * The herdr plugins of the PC on screen and what each can do, to read only: installing, enabling
 * and removing a plugin stay with herdr. Nothing is drawn where there is none to list.
 */
function PluginsGroup() {
  const t = useT();
  const api = useMachineApi();
  const [plugins, setPlugins] = useState<PluginActions[]>([]);
  useEffect(() => {
    let current = true;
    void api.fetchPluginActions().then((list) => { if (current) setPlugins(list); }, () => { if (current) setPlugins([]); });
    return () => { current = false; };
  }, [api]);
  if (plugins.length === 0) return null;
  return (
    <SettingsGroup title={t("herdr plugins")} note={t("The command palette and its plugin actions are not available in the phone touch UI. Use a wider screen or a keyboard's command palette shortcut.")} className="settings-plugins">
      {plugins.map((plugin) => (
        <SettingsRow key={plugin.plugin_id} label={`${plugin.name} ${plugin.version}`} description={plugin.actions.length > 0 ? plugin.actions.map((action) => action.title).join(" · ") : t("No actions")}>
          <span className="settings-hint">{plugin.enabled ? t("Enabled") : t("Disabled")}</span>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function AboutPage({ updates, herdrVersion, bridgesFollow }: { updates: UpdatesModel; herdrVersion: string | null; bridgesFollow: boolean }) {
  const t = useT();
  return (
    <>
      <UpdateControls updates={updates} bridgesFollow={bridgesFollow} />
      <HerdrUpdateControls enabled herdrVersion={herdrVersion} />
      <PluginsGroup />
      <SettingsGroup title={t("About")} className="settings-about" section="about">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">T-Rex</span>
            <span className="settings-description">{t("Built like Superlogical's Rex, on herdr and restty.")}</span>
          </div>
          <a className="btn" href="https://github.com/alexanderkreidich/t-rex" target="_blank" rel="noreferrer"><Star aria-hidden="true" />{t("Star on GitHub")}</a>
        </div>
      </SettingsGroup>
    </>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  // mounted per opening: every opening starts on the list, with nothing left from the last one
  // a page that cannot be drawn closes to the app instead of blanking it; the next opening tries again
  return props.open ? <RenderBoundary resetKey={null} fallback={() => <SettingsCrash onClose={props.onClose} overPreview={props.overPreview ?? false} />}>
    <CrashProbe region="settings" />
    <OpenSettingsDialog {...props} />
  </RenderBoundary> : null;
}

/**
 * Still a modal: Escape, the swipe down on a phone, the system Back button and the kept focus
 * close it as they close Settings, and it sits over a file preview as Settings does.
 */
function SettingsCrash({ onClose, overPreview }: { onClose: () => void; overPreview: boolean }) {
  const t = useT();
  // one entry of the history, whatever the crashed dialog had recorded: Back takes it off and the
  // app closes Settings (lib/settingsHistory.ts). Not settingsLevels: a wide dialog's list is none
  useEffect(() => { recordSettings([{ page: null, keyBar: false }]); }, []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeRef });
  useSheetSwipe(surface, onClose);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={surface} className="modal" role="dialog" aria-modal="true" aria-label={t("Settings")} tabIndex={-1}>
        <RegionCrash message={t("Settings can't be shown.")} retry={onClose} retryLabel={t("Close")} buttonRef={closeRef} />
      </div>
    </div>
  );
}

/**
 * A change the server refused to save, on whichever page is open: the plain sentence (lib/userError.ts),
 * the server's own words behind Details. It stays until a save lands; the change is sent again
 * every few seconds meanwhile (lib/preferencesSync.ts).
 */
function SaveFailure({ error }: { error: UserError }) {
  const t = useT();
  return <div className="settings-save-error" role="alert">
    {error.detail === null ? <p>{error.message}</p> : <details className="settings-details">
      <summary>{error.message}<span className="settings-details-toggle">{t("Details")}</span></summary>
      <code>{error.detail}</code>
    </details>}
  </div>;
}

function OpenSettingsDialog({ section = null, linkPage = null, linkSection = null, onPage, onClose, actions, updates, auth, herdrVersion, onEnableNotifications, saveError, overPreview = false }: SettingsDialogProps) {
  const t = useT();
  const narrow = useNarrow();
  // opened by Forward, the dialog shows what that entry of the history showed
  const [restored] = useState(() => shownBy(settingsEntry(window.history.state)));
  // a phone opens on the list of pages; a wider dialog shows the list beside the first page. A
  // button that points at Updates opens on About whatever an entry still landing would restore
  const linked = PAGES.find((candidate) => candidate.id === linkPage)?.id ?? null;
  // a page the command palette named opens first; the request is read, not taken, so a remount in development finds it again
  const [asked] = useState(requestedSettingsPage);
  useEffect(() => requestSettingsPage(null), []);
  const [chosen, setChosen] = useState<SettingsPage | null>(section === "updates" ? "about" : asked ?? (restored ? restored.page : linked));
  const page = chosen ?? (narrow ? null : PAGES[0]!.id);
  const [keyBarOpen, setKeyBarOpen] = useState(section === "updates" ? false : restored?.keyBar ?? false);
  // every step in is an entry of the history, so the system Back button takes one step out
  // (lib/settingsHistory.ts); the Back control, the X and Escape take the same entries off
  useEffect(() => { recordSettings(settingsLevels(narrow, page, keyBarOpen)); }, [narrow, page, keyBarOpen]);
  useEffect(() => { onPage?.(page); }, [onPage, page]);
  useEffect(() => onSettingsHistory((entry, own) => {
    const view = own ? null : shownBy(entry);
    if (view === null) return;
    setChosen(view.page);
    setKeyBarOpen(view.keyBar);
  }), []);
  const keyBarButtonRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsScrollRef = useRef(0);
  // Tab stays inside the dialog, and the focus returns to whatever opened it
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus: backRef });
  useSheetSwipe(surface, onClose);
  const shown = useRef<{ page: SettingsPage | null; keyBar: boolean } | null>(null);
  const label = (id: SettingsPage): string => t(id === "appearance" ? "Appearance" : id === "terminal" ? "Terminal" : id === "alerts" ? "Alerts"
    : id === "shortcuts" ? "Shortcuts" : id === "devices" ? "Phone & devices" : id === "remote" ? "Remote PCs" : id === "integrations" ? "Agent integrations" : "About");
  const openPage = (id: SettingsPage): void => { setKeyBarOpen(false); setChosen(id); };
  const openKeyBar = (): void => {
    settingsScrollRef.current = settingsBodyRef.current?.scrollTop ?? 0;
    setKeyBarOpen(true);
  };
  const goBack = (): void => {
    if (keyBarOpen) setKeyBarOpen(false);
    else setChosen(null);
  };
  const tab = (id: SettingsPage | null): HTMLElement | null => tabsRef.current?.querySelector<HTMLElement>(id === null ? '[role="tab"]' : `[data-settings-page="${id}"]`) ?? null;
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { page, keyBar: keyBarOpen };
    if (keyBarOpen) backRef.current?.focus();
    else if (before?.keyBar && before.page === page) {
      if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = settingsScrollRef.current;
      keyBarButtonRef.current?.focus({ preventScroll: true });
    } else if (before === null) {
      // a button that points at Updates opens on it, and the focus goes there too; so does a link to a group
      const named = section === "updates" ? "updates" : linked && linkSection ? linkSection : null;
      const pointed = named ? settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(named)}"]`) : null;
      if (pointed) { pointed.focus({ preventScroll: true }); pointed.scrollIntoView(); }
      else tab(page)?.focus();
    } else if (before.page !== page && narrow) {
      // a phone shows one of the two: the focus follows into the page, and back onto its row
      if (page !== null) backRef.current?.focus();
      else tab(before.page)?.focus();
    }
  }, [page, keyBarOpen, narrow, section]);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  // asked when a page that shows them opens, so a request that failed earlier is made again
  useEffect(() => {
    if (page !== "remote" && page !== "about") return;
    let live = true;
    machineRequest<MachineSettings>("/settings").then((settings) => { if (live) setPcSettings(settings); }, () => { if (live) setPcSettings(null); });
    return () => { live = false; };
  }, [page]);
  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      // an Escape that cancels an IME composition (the editor's Character field) is the IME's
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      // out of the key bar editor first; from any page, a phone's included, it closes the dialog
      if (keyBarOpen) setKeyBarOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, keyBarOpen]);

  /** the list is one Tab stop: the arrows walk it, and beside an open page they turn the page too */
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? PAGES.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = PAGES[(to + PAGES.length) % PAGES.length]!.id;
    tab(next)?.focus();
    if (!narrow) openPage(next);
  };

  const body = (): ReactNode => {
    switch (page) {
      case "appearance": return <AppearancePage />;
      case "terminal": return <TerminalPage keyBarButtonRef={keyBarButtonRef} onEditKeyBar={openKeyBar} />;
      case "alerts": return <AlertsPage onEnableNotifications={onEnableNotifications} />;
      case "shortcuts": return <ShortcutsPage />;
      case "devices": return <DevicesPage auth={auth} onSignOut={actions.lock} />;
      case "remote": return <RemotePcsPage actions={actions} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} />;
      case "integrations": return <IntegrationsPage />;
      case "about": return <AboutPage updates={updates} herdrVersion={herdrVersion} bridgesFollow={pcSettings?.auto_update_bridges === true} />;
      default: return null;
    }
  };
  const listShown = !narrow || (page === null && !keyBarOpen);
  const focusable = page ?? PAGES[0]!.id;

  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {/* named Settings on every page: the page's own name is the visible title */}
      <section ref={surface} className="modal settings-dialog" role="dialog" aria-modal="true" aria-label={keyBarOpen ? t("Key bar") : t("Settings")} tabIndex={-1}>
        <header className="modal-header settings-header">
          {(keyBarOpen || (narrow && page !== null)) && <button type="button" ref={backRef} className="icon-button" aria-label={t("Back to settings")} onClick={goBack}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title">{keyBarOpen ? t("Key bar") : page === null ? t("Settings") : label(page)}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {listShown && (
          <nav className="settings-nav" aria-label={t("Settings")}>
            <p className="settings-nav-title" aria-hidden="true">{t("Settings")}</p>
            <div ref={tabsRef} className="settings-tabs" role="tablist" aria-orientation="vertical">
              {PAGES.map(({ id, icon: Icon }, index) => (
                <button key={id} type="button" role="tab" className="settings-tab" data-settings-page={id} aria-selected={page === id} aria-controls={page === id ? "settings-panel" : undefined} tabIndex={focusable === id ? 0 : -1} onClick={() => openPage(id)} onKeyDown={(event) => onTabKey(event, index)}>
                  <Icon aria-hidden="true" />
                  <span>{label(id)}</span>
                  <ChevronRight className="settings-tab-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
        )}
        {page !== null && <div key={page} ref={settingsBodyRef} id="settings-panel" className="modal-body settings-body" role="tabpanel" aria-label={label(page)} hidden={keyBarOpen}>{saveError !== null && <SaveFailure error={saveError} />}{body()}</div>}
        {keyBarOpen && <div className="modal-body settings-key-bar-body"><KeyBarSettings /></div>}
      </section>
    </div>
  );
}
