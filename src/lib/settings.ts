/**
 * User preferences: one localStorage record, one React context, applied to the
 * document as `data-theme` / `data-density` / `data-chat-width` attributes that src/styles.css keys
 * its token overrides on. The terminal reads no CSS, so `terminalTheme()` mirrors the
 * `--term-*` tokens of each theme for PaneTerminal's colours (lib/restty/theme.ts).
 */

import { mirrorPalette, SHARED_SETTING_KEYS, type SharedSettingKey } from "../../shared/preferences.ts";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_THEME, isThemeId, terminalColors, themeColor as themeTableColor, type ThemeId, type ThemeEntry } from "./themes.ts";
import { LANGUAGE_SETTINGS, LOCALE_TAGS, resolveLanguage, setCurrentLanguage, type Language, type LanguageSetting } from "./i18n.ts";
import type { AlertPrefs, DoneAlerts } from "../../shared/notify-policy.ts";
import { chatFontStack, sanitizeFontFamily } from "./fontFamily.ts";
import { fontScale, sanitizeUiFontSize } from "./typography.ts";
import { sanitizeKeyBarExtras, type KeyBarExtra } from "./keys.ts";
import { themeFor } from "./themeFor.ts";
import { DEFAULT_KEY_BAR_ITEMS, migrateKeyBarItems, sanitizeKeyBarItems, type KeyBarItem } from "./keyBar.ts";

export type ThemeSetting = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type Density = "compact" | "comfortable";
/** One line names the workspace; two lines say what its pane is doing, with the workspace under it. */
export type SidebarRows = "one" | "two";
/** the Agents list's order: herdr's workspace order, or a waiting agent first and then the latest change */
export type AgentOrder = "workspace" | "activity";
/** how agent logos are drawn: in their brand colors, or without color: Claude's in the text color, the others in grey (data-marks on <html>) */
export type AgentMarks = "color" | "mono";
/** amber: the herdr look (the default before codex); charcoal: neutral Ghostty-style dark;
 *  catppuccin: Catppuccin Mocha in dark, Latte in light. A record naming a palette that was removed
 *  (report, lilac, forest) loads as amber. */
export type Palette = ThemeId;
/** Legacy chat width retained for saved-settings compatibility. */
export type ChatWidth = "narrow" | "default" | "wide" | "full";
export const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "default", "wide", "full"];
/** the lens a pane opens in until it is switched there: auto is chat for an agent on a touch screen, else terminal */
export type DefaultView = "auto" | "chat" | "terminal";
import { sanitizeShortcutOverrides, type ShortcutOverrides } from "./shortcutBindings.ts";
import type { StatusIndicators } from "./status.ts";
import { WEB_LINK_TARGETS, type WebLinkTarget } from "./webPanel.ts";
import { FILE_OPEN_TARGETS, type FilePresentation } from "./filePresentation.ts";
import { CLAUDE_LAUNCH_MODES, CODEX_LAUNCH_MODES, type ClaudeLaunchMode, type CodexLaunchMode } from "./agentLaunchMode.ts";

export interface Settings {
  terminalInputMode: "auto" | "line" | "direct";
  /** Kept for migration of the old fixed-order bar. New layouts use keyBarItems. */
  keyBarExtras: KeyBarExtra[];
  /** This device's terminal keys, sticky modifiers and exact chords, in display order. */
  keyBarItems: KeyBarItem[];
  shortcutOverrides: ShortcutOverrides;
  theme: ThemeSetting;
  density: Density;
  /** How much a workspace row says: its name, or its pane's title over its place. */
  sidebarRows: SidebarRows;
  /** Focus mode: from 769px, with the sidebar shown, the tabs live under their workspaces and the bar over the pane goes */
  focusMode: boolean;
  /** The Agents list's order. Activity is display-only: herdr's own order never changes. */
  agentOrder: AgentOrder;
  /** Agent logos: brand colors, or without color, so a list of one agent is not a stripe of tiles */
  agentMarks: AgentMarks;
  /** the sidebar's state marks: this app's own, or herdr's dots or symbols, as its `[ui] status_indicators` (lib/status.ts) */
  statusIndicators: StatusIndicators;
  /** the chrome color family, keyed as data-palette in src/styles.css */
  palette: Palette;
  /** Legacy mirrors for older app versions. */
  paletteLight: Palette;
  paletteDark: Palette;
  darkTheme: ThemeId;
  lightTheme: ThemeId;
  /** the terminal's font size in px */
  terminalFontSize: number;
  /** mouse reports sent to herdr per wheel event in the terminal: 1 is what the terminal sends by itself */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in JetBrains Mono, as a CSS font-family list; "" keeps the built-in one */
  terminalFontFamily: string;
  /** programming ligatures (->, !=, =>) drawn as one glyph where the font has them, as Ghostty does */
  terminalLigatures: boolean;
  /** the GPU interface the terminal draws with: auto takes WebGPU where the browser has it, else WebGL2 */
  terminalRenderer: TerminalRenderer;
  /** one of Ghostty's themes (restty's built-in set) for the terminal's colours; "" follows the app's theme */
  terminalThemeName: string;
  /** let a pane's OSC 52 sequence write the clipboard (lib/osc52.ts), as vim, tmux and Claude Code copy;
   *  on unless chosen off, since any process in the pane can then plant text the user pastes elsewhere.
   *  Stored under this key, not 0.4.1's `terminalOsc52`: settings are saved whole, so a `false` there
   *  was written by any change at all, not chosen, and is ignored. */
  paneClipboard: boolean;
  /** a desktop tab out of use for a moment detaches its pane (PaneTerminal's release) and only watches it, so herdr's own
   *  window keeps the pane at its size; paused where the server cannot watch. Off: the tab keeps the pane and its size. */
  releasePaneAway: boolean;
  /** chat text size in px (its body text; the rest scales with it); null follows the interface size */
  chatFontSize: number | null;
  /** fonts tried before the UI font in the chat's prose (code stays mono), as a CSS font-family list; "" keeps the UI font */
  chatFontFamily: string;
  /** the interface's body size in px (--fs-md; every other --fs-* scales with it as --ui-scale); null follows the density.
   *  The chat follows it until it has a size of its own; the terminal keeps terminalFontSize */
  uiFontSize: number | null;
  /** Legacy chat lane width. */
  chatWidth: ChatWidth;
  /** true: Enter sends in the composer, Shift+Enter breaks the line; false: Ctrl/Cmd+Enter sends */
  enterSends: boolean;
  /** true: a message sent while the agent works goes by itself when the turn ends; false: it waits for Send now */
  autoSendQueued: boolean;
  /** on a touch screen, a chip above the message box offers the prompt the agent suggests next.
   * Not `showSuggestionChip`: that key was on by default until 0.4.9 and is still stored on phones */
  suggestionChip: boolean;
  /** show the agent's folded reasoning blocks in the chat view */
  showThinking: boolean;
  /** request a screen wake lock while a pane is open in this visible tab */
  keepScreenOn: boolean;
  /** UI language; `system` follows the browser (src/lib/i18n.ts) */
  language: LanguageSetting;
  /** alerts on this device at all: the bell turns them off (push subscription dropped) and on */
  alertsOn: boolean;
  /** alert this device when an agent waits on the user (shared/notify-policy.ts AlertPrefs) */
  alertInput: boolean;
  /** alert this device when a turn finishes: never, after a long one, or every one */
  alertDone: DoneAlerts;
  /** one-tap replies above the composer, in order; blank ones are kept while being typed, never shown */
  quickReplies: string[];
  /** whether the quick replies show above the composer at all */
  showQuickReplies: boolean;
  /** the remote PCs (SSH, saved in herdr) in the sidebar and its notices; off: the Host alone. Add PC turns it on */
  showRemotePcs: boolean;
  /** every pane's lens until switched in that pane; changing it puts every pane back on it */
  defaultView: DefaultView;
  /** the file viewer wraps long lines instead of scrolling sideways */
  wrapCode: boolean;
  /** the width of a Markdown preview: the chat's lane (--chat-w), centered, or the viewer's width */
  markdownWidth: MarkdownWidth;
  /** a repository diff as one column of old and new lines, or the two side by side (a phone shows one column either way) */
  diffStyle: DiffStyle;
  /** where a file opens from the chat, terminal or Files: the popup, or beside the pane on a wide window (lib/filePresentation.ts) */
  fileOpen: FilePresentation;
  /** where a click on a web address opens it: a new tab, or the panel beside the pane (lib/webPanel.ts); Shift opens the other one */
  webLinks: WebLinkTarget;
  /** the mode a Claude Code started from the New worktree dialog runs in (lib/agentLaunchMode.ts); default adds no flag */
  claudeLaunchMode: ClaudeLaunchMode;
  /** the same for Codex: a sandbox and approval preset */
  codexLaunchMode: CodexLaunchMode;
}

export const TERMINAL_RENDERERS = ["auto", "webgpu", "webgl2"] as const;
export type TerminalRenderer = (typeof TERMINAL_RENDERERS)[number];
export const MARKDOWN_WIDTHS = ["readable", "full"] as const;
export type MarkdownWidth = (typeof MARKDOWN_WIDTHS)[number];
export const DIFF_STYLES = ["unified", "split"] as const;
export type DiffStyle = (typeof DIFF_STYLES)[number];

/**
 * Which settings every browser of this server shares (shared/preferences.ts, lib/preferencesSync.ts)
 * and which stay this device's: its screen, keyboard, terminal, alerts and microphone. A new setting
 * must be placed here, or the build fails; when in doubt it is the device's.
 */
export const SETTING_SCOPE = {
  theme: "shared", palette: "shared", darkTheme: "shared", lightTheme: "shared", language: "shared", sidebarRows: "shared", agentOrder: "shared",
  agentMarks: "shared", autoSendQueued: "shared", showThinking: "shared", quickReplies: "shared",
  showQuickReplies: "shared", showRemotePcs: "shared", defaultView: "device", suggestionChip: "device",
  terminalInputMode: "device", keyBarExtras: "device", keyBarItems: "device", shortcutOverrides: "device", density: "device",
  terminalFontSize: "device",
  terminalWheelSpeed: "device", terminalFontFamily: "device", terminalLigatures: "device", terminalRenderer: "device", terminalThemeName: "device",
  paneClipboard: "device", releasePaneAway: "device", focusMode: "device",
  chatFontSize: "device", chatFontFamily: "device", uiFontSize: "device", chatWidth: "device", enterSends: "device",
  keepScreenOn: "device", alertsOn: "device", alertInput: "device", alertDone: "device",
  paletteLight: "device", paletteDark: "device", statusIndicators: "device",
  // Viewer layout follows this screen, as chatWidth does.
  wrapCode: "device", markdownWidth: "device", diffStyle: "device", fileOpen: "device", webLinks: "device",
  // a new agent starts the same way whichever device opened it
  claudeLaunchMode: "shared", codexLaunchMode: "shared",
} as const satisfies Record<keyof Settings, "shared" | "device">;

/** The shared part of `settings`, by the names shared/preferences.ts lists. */
export function sharedSettings(settings: Settings): Partial<Record<SharedSettingKey, unknown>> {
  return Object.fromEntries(SHARED_SETTING_KEYS.map((key) => [key, settings[key]]));
}

export const DEFAULT_SETTINGS: Settings = {
  terminalInputMode: "auto",
  keyBarExtras: ["alt"],
  keyBarItems: DEFAULT_KEY_BAR_ITEMS,
  shortcutOverrides: {},
  theme: "dark",
  density: "comfortable",
  sidebarRows: "one",
  focusMode: true,
  agentOrder: "workspace",
  agentMarks: "color",
  statusIndicators: "classic",
  palette: DEFAULT_THEME,
  paletteLight: DEFAULT_THEME,
  paletteDark: DEFAULT_THEME,
  darkTheme: DEFAULT_THEME,
  lightTheme: DEFAULT_THEME,
  terminalFontSize: 13,
  terminalWheelSpeed: 1,
  terminalFontFamily: "",
  terminalLigatures: true,
  terminalRenderer: "auto",
  terminalThemeName: "",
  paneClipboard: true,
  releasePaneAway: false,
  chatFontSize: null,
  chatFontFamily: "",
  uiFontSize: null,
  chatWidth: "default",
  enterSends: true,
  autoSendQueued: true,
  suggestionChip: false,
  showThinking: false,
  keepScreenOn: false,
  language: "system",
  alertsOn: true,
  alertInput: true,
  alertDone: "long",
  quickReplies: ["continue", "yes", "no", "commit and push", "retry"],
  showQuickReplies: false,
  showRemotePcs: false,
  defaultView: "auto",
  wrapCode: false,
  markdownWidth: "readable",
  diffStyle: "unified",
  fileOpen: "popup",
  webLinks: "tab",
  claudeLaunchMode: "default",
  codexLaunchMode: "default",
};

export const QUICK_REPLIES_MAX = 12;
export const QUICK_REPLY_MAX_CHARS = 200;

/** This device's alert choices, as the server keeps them with its push subscription. */
export function alertPrefs(settings: Settings): AlertPrefs {
  return { input: settings.alertInput, done: settings.alertDone };
}

const STORAGE_KEY = "t-rex:settings";
const THEMES_STORAGE_KEY = "t-rex:themes";
export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_WHEEL_SPEED_MIN = 1;
export const TERMINAL_WHEEL_SPEED_MAX = 10;

export const CHAT_FONT_MIN = 11;
export const CHAT_FONT_MAX = 24;
/** each density's body size, --fs-md in src/styles.css: the interface's size when none is chosen, and through it the chat's */
const BODY_FONT: Record<Density, number> = { comfortable: 14, compact: 13 };

function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/** The interface's body text size in px: the chosen one, or the density's. */
export function uiFontSize(settings: Settings): number {
  return settings.uiFontSize ?? BODY_FONT[settings.density];
}

/** The chat's body text size in px: the chosen one, or the interface's. */
export function chatFontSize(settings: Settings): number {
  return settings.chatFontSize ?? uiFontSize(settings);
}

/** Only known keys with the right type survive: a stale or hand-edited record never breaks the UI. */
export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const theme = record["theme"] === "dark" || record["theme"] === "light" || record["theme"] === "system" ? record["theme"] : DEFAULT_SETTINGS.theme;
  const palette = isThemeId(record["palette"]) ? record["palette"] : "amber";
  // Absence migrates (a record from before themes wore amber, so it keeps amber); an explicitly
  // unknown id falls back to the default, not a stale pair.
  const darkTheme = "darkTheme" in record
    ? (isThemeId(record["darkTheme"]) ? record["darkTheme"] : DEFAULT_THEME)
    : theme === "dark" ? palette : isThemeId(record["paletteDark"]) ? record["paletteDark"] : theme === "system" && record["paletteDark"] !== undefined ? "amber" : palette;
  const lightTheme = "lightTheme" in record
    ? (isThemeId(record["lightTheme"]) ? record["lightTheme"] : DEFAULT_THEME)
    : theme === "light" ? palette : isThemeId(record["paletteLight"]) ? record["paletteLight"] : theme === "system" && record["paletteLight"] !== undefined ? "amber" : palette;
  const density = record["density"];
  const font = record["terminalFontSize"];
  const chatFont = record["chatFontSize"];
  const keyBarExtras = sanitizeKeyBarExtras(record["keyBarExtras"], DEFAULT_SETTINGS.keyBarExtras);
  const keyBarFallback = Array.isArray(record["keyBarExtras"])
    ? migrateKeyBarItems(keyBarExtras)
    : DEFAULT_KEY_BAR_ITEMS;
  return {
    terminalInputMode: record["terminalInputMode"] === "line" || record["terminalInputMode"] === "direct" ? record["terminalInputMode"] : "auto",
    keyBarExtras,
    keyBarItems: sanitizeKeyBarItems(record["keyBarItems"], keyBarFallback),
    shortcutOverrides: sanitizeShortcutOverrides(record["shortcutOverrides"]),
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : DEFAULT_SETTINGS.theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_SETTINGS.density,
    sidebarRows: record["sidebarRows"] === "one" || record["sidebarRows"] === "two" ? record["sidebarRows"] : DEFAULT_SETTINGS.sidebarRows,
    focusMode: typeof record["focusMode"] === "boolean" ? record["focusMode"] : DEFAULT_SETTINGS.focusMode,
    agentOrder: record["agentOrder"] === "workspace" || record["agentOrder"] === "activity" ? record["agentOrder"] : DEFAULT_SETTINGS.agentOrder,
    agentMarks: record["agentMarks"] === "color" || record["agentMarks"] === "mono" ? record["agentMarks"] : DEFAULT_SETTINGS.agentMarks,
    statusIndicators: record["statusIndicators"] === "classic" || record["statusIndicators"] === "dots" || record["statusIndicators"] === "symbols" ? record["statusIndicators"] : DEFAULT_SETTINGS.statusIndicators,
    darkTheme,
    lightTheme,
    palette: mirrorPalette(theme, darkTheme, lightTheme),
    paletteLight: lightTheme,
    paletteDark: darkTheme,
    terminalFontSize: typeof font === "number" && Number.isFinite(font) ? clampFont(font) : DEFAULT_SETTINGS.terminalFontSize,
    terminalWheelSpeed: typeof record["terminalWheelSpeed"] === "number" && Number.isFinite(record["terminalWheelSpeed"])
      ? Math.min(TERMINAL_WHEEL_SPEED_MAX, Math.max(TERMINAL_WHEEL_SPEED_MIN, Math.round(record["terminalWheelSpeed"])))
      : DEFAULT_SETTINGS.terminalWheelSpeed,
    chatFontSize: typeof chatFont === "number" && Number.isFinite(chatFont)
      ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(chatFont)))
      : DEFAULT_SETTINGS.chatFontSize,
    terminalFontFamily: sanitizeFontFamily(record["terminalFontFamily"]),
    terminalLigatures: typeof record["terminalLigatures"] === "boolean" ? record["terminalLigatures"] : DEFAULT_SETTINGS.terminalLigatures,
    terminalRenderer: TERMINAL_RENDERERS.includes(record["terminalRenderer"] as TerminalRenderer) ? record["terminalRenderer"] as TerminalRenderer : DEFAULT_SETTINGS.terminalRenderer,
    // a name restty does not know draws the app's colours (lib/restty/theme.ts)
    terminalThemeName: typeof record["terminalThemeName"] === "string" && record["terminalThemeName"].length <= 100 ? record["terminalThemeName"] : DEFAULT_SETTINGS.terminalThemeName,
    uiFontSize: sanitizeUiFontSize(record["uiFontSize"]),
    paneClipboard: typeof record["paneClipboard"] === "boolean" ? record["paneClipboard"] : DEFAULT_SETTINGS.paneClipboard,
    releasePaneAway: typeof record["releasePaneAway"] === "boolean" ? record["releasePaneAway"] : DEFAULT_SETTINGS.releasePaneAway,
    chatFontFamily: sanitizeFontFamily(record["chatFontFamily"]),
    chatWidth: CHAT_WIDTHS.includes(record["chatWidth"] as ChatWidth) ? record["chatWidth"] as ChatWidth : DEFAULT_SETTINGS.chatWidth,
    enterSends: typeof record["enterSends"] === "boolean" ? record["enterSends"] : DEFAULT_SETTINGS.enterSends,
    autoSendQueued: typeof record["autoSendQueued"] === "boolean" ? record["autoSendQueued"] : DEFAULT_SETTINGS.autoSendQueued,
    suggestionChip: typeof record["suggestionChip"] === "boolean" ? record["suggestionChip"] : DEFAULT_SETTINGS.suggestionChip,
    showThinking: typeof record["showThinking"] === "boolean" ? record["showThinking"] : DEFAULT_SETTINGS.showThinking,
    keepScreenOn: typeof record["keepScreenOn"] === "boolean" ? record["keepScreenOn"] : DEFAULT_SETTINGS.keepScreenOn,
    language: LANGUAGE_SETTINGS.includes(record["language"] as LanguageSetting) ? record["language"] as LanguageSetting : DEFAULT_SETTINGS.language,
    alertsOn: typeof record["alertsOn"] === "boolean" ? record["alertsOn"] : DEFAULT_SETTINGS.alertsOn,
    alertInput: typeof record["alertInput"] === "boolean" ? record["alertInput"] : DEFAULT_SETTINGS.alertInput,
    alertDone: record["alertDone"] === "off" || record["alertDone"] === "long" || record["alertDone"] === "always" ? record["alertDone"] : DEFAULT_SETTINGS.alertDone,
    // kept as typed (a trailing space is the next word being started), only bounded
    quickReplies: Array.isArray(record["quickReplies"])
      ? record["quickReplies"].filter((reply): reply is string => typeof reply === "string").slice(0, QUICK_REPLIES_MAX).map((reply) => reply.slice(0, QUICK_REPLY_MAX_CHARS))
      : [...DEFAULT_SETTINGS.quickReplies],
    showQuickReplies: typeof record["showQuickReplies"] === "boolean" ? record["showQuickReplies"] : DEFAULT_SETTINGS.showQuickReplies,
    showRemotePcs: typeof record["showRemotePcs"] === "boolean" ? record["showRemotePcs"] : DEFAULT_SETTINGS.showRemotePcs,
    defaultView: record["defaultView"] === "chat" || record["defaultView"] === "terminal" || record["defaultView"] === "auto" ? record["defaultView"] : DEFAULT_SETTINGS.defaultView,
    wrapCode: typeof record["wrapCode"] === "boolean" ? record["wrapCode"] : DEFAULT_SETTINGS.wrapCode,
    markdownWidth: MARKDOWN_WIDTHS.find((width) => width === record["markdownWidth"]) ?? DEFAULT_SETTINGS.markdownWidth,
    diffStyle: DIFF_STYLES.find((style) => style === record["diffStyle"]) ?? DEFAULT_SETTINGS.diffStyle,
    fileOpen: FILE_OPEN_TARGETS.find((target) => target === record["fileOpen"]) ?? DEFAULT_SETTINGS.fileOpen,
    webLinks: WEB_LINK_TARGETS.find((target) => target === record["webLinks"]) ?? DEFAULT_SETTINGS.webLinks,
    claudeLaunchMode: CLAUDE_LAUNCH_MODES.find((mode) => mode === record["claudeLaunchMode"]) ?? DEFAULT_SETTINGS.claudeLaunchMode,
    codexLaunchMode: CODEX_LAUNCH_MODES.find((mode) => mode === record["codexLaunchMode"]) ?? DEFAULT_SETTINGS.codexLaunchMode,
  };
}

export function loadSettings(): Settings {
  let settings = DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    settings = raw === null ? DEFAULT_SETTINGS : sanitizeSettings(JSON.parse(raw));
  } catch {
    /* a damaged main record does not hide the protected theme choice */
  }
  try {
    const raw = window.localStorage.getItem(THEMES_STORAGE_KEY);
    const themes: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof themes === "object" && themes !== null && "darkTheme" in themes && "lightTheme" in themes) {
      return sanitizeSettings({ ...settings, darkTheme: themes.darkTheme, lightTheme: themes.lightTheme });
    }
  } catch { /* denied or damaged storage: keep the main record */ }
  return settings;
}

export function saveSettings(settings: Settings): void {
  const mirrored = sanitizeSettings(settings);
  try {
    window.localStorage.setItem(THEMES_STORAGE_KEY, JSON.stringify({
      darkTheme: mirrored.darkTheme, lightTheme: mirrored.lightTheme,
      mirror: { palette: mirrored.palette, paletteDark: mirrored.paletteDark, paletteLight: mirrored.paletteLight },
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mirrored));
  } catch {
    /* private mode: preferences last for the session */
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "system") return setting;
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

type TerminalColors = { background: string; foreground: string; cursor: string; selectionBackground: string };

export function terminalTheme(theme: ResolvedTheme, palette: Palette = "amber"): TerminalColors {
  return { ...terminalColors(palette, theme) };
}

/** `<meta name="theme-color">` follows the panel surface so the PWA title bar matches. */
export function themeColor(theme: ResolvedTheme, palette: Palette = "amber"): string {
  return themeTableColor(palette, theme);
}

export function applyToDocument(settings: Settings, entry: ThemeEntry, language: Language): void {
  const root = document.documentElement;
  root.lang = LOCALE_TAGS[language];
  root.dataset["theme"] = entry.mode;
  root.dataset["density"] = settings.density;
  root.dataset["palette"] = entry.id;
  root.dataset["chatWidth"] = settings.chatWidth;
  // src/components/AgentMark.css keys the mono logos on it
  root.dataset["marks"] = settings.agentMarks;
  // src/styles.css multiplies every --fs-* token but --fs-input by this: the interface's body size over the density's
  const uiPx = uiFontSize(settings);
  root.style.setProperty("--ui-scale", String(fontScale(uiPx, BODY_FONT[settings.density])));
  // ChatView.css scales its type tokens by this (the chat's and a Markdown preview's): the chat's size over the
  // interface's, so a chosen chat size is drawn as itself whatever the interface size, and an unchosen one follows it
  root.style.setProperty("--chat-scale", String(fontScale(chatFontSize(settings), uiPx)));
  // ChatView.css sets the transcript's and a Markdown preview's prose in this, and falls back to --font-ui without it
  const chatFont = chatFontStack(settings.chatFontFamily);
  if (chatFont === null) root.style.removeProperty("--font-chat");
  else root.style.setProperty("--font-chat", chatFont);
  root.style.colorScheme = entry.mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor(entry.mode, entry.id));
}

interface SettingsContextValue {
  settings: Settings;
  /** the theme after resolving `system` against the OS preference */
  resolvedTheme: ResolvedTheme;
  /** The actual rendered row, whose mode may differ from the selected side. */
  resolvedEntry: ThemeEntry;
  /** the language after resolving `system` against the browser's */
  resolvedLanguage: Language;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemDark, setSystemDark] = useState(() => resolveTheme("system") === "dark");

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const resolvedEntry = themeFor(settings, resolvedTheme);

  const [browserLanguages, setBrowserLanguages] = useState<readonly string[]>(() => (typeof navigator !== "undefined" ? navigator.languages : []));
  useEffect(() => {
    const onChange = (): void => setBrowserLanguages([...navigator.languages]);
    window.addEventListener("languagechange", onChange);
    return () => window.removeEventListener("languagechange", onChange);
  }, []);
  const resolvedLanguage = resolveLanguage(settings.language, browserLanguages);
  // helpers outside React read this during the same render, so it is set before the children render
  setCurrentLanguage(resolvedLanguage);

  useEffect(() => {
    applyToDocument(settings, resolvedEntry, resolvedLanguage);
  }, [settings, resolvedEntry, resolvedLanguage]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = sanitizeSettings({ ...current, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, resolvedTheme, resolvedEntry, resolvedLanguage, update }), [settings, resolvedTheme, resolvedEntry, resolvedLanguage, update]);
  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings needs a SettingsProvider above it");
  return value;
}

