/** Actual PTY queries and Pi system-theme updates through an isolated Herdr and browser. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { terminalColors } from "../src/lib/themes.ts";
import { ghosttyThemeNames, terminalColorsTheme, terminalDisplayTheme } from "../src/lib/restty/theme.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const root = mkdtempSync(join(tmpdir(), "terminal-theme-"));
const evidence = mkdtempSync(join(tmpdir(), "terminal-theme-evidence-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
let workspace: string | undefined;
const probeState = join(root, "query-state.json");
const piState = join(root, "pi-state.json");
const read = (path: string): Record<string, any> | null => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(read(probeState))}; Pi: ${JSON.stringify(read(piState))}`);
    await Bun.sleep(25);
  }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const luminance = (rgb: { r: number; g: number; b: number }): number => {
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};
const expected = (palette: string, mode: "dark" | "light", ghostty = "") => terminalDisplayTheme(terminalColorsTheme(ghostty, terminalColors(palette, mode)))!;

try {
  const made = await workspaceCreate({ cwd: root, label: "terminal-theme-regression" });
  workspace = made.workspace.workspace_id;
  const pane = made.root_pane.pane_id;
  const context = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 820 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("t-rex:settings")) localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en", theme: "system", darkTheme: "amber", lightTheme: "amber" }));
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator('.pane-frame.is-current .restty-terminal[data-ready="true"]').waitFor();
  await page.locator(".pane-frame.is-current .restty-terminal").click();

  const probe = join(root, "query.cjs");
  writeFileSync(probe, String.raw`
const fs = require('node:fs');
const state = { colors: {}, reports: [] };
let buffer = '';
const queries = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;4;?\x1b\\';
const rgb = (parts) => Object.fromEntries(['r','g','b'].map((key, index) => [key, Math.round(parseInt(parts[index], 16) * 255 / (16 ** parts[index].length - 1))]));
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  if (chunk.includes(120)) { process.stdin.setRawMode(false); fs.writeFileSync(${JSON.stringify(join(root, "probe-done"))}, 'done'); process.exit(0); }
  buffer += chunk.toString();
  buffer = buffer.replace(/\x1b\](10|11|4);(?:4;)?rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x1b\\|\x07)|\x1b\[\?997;([12])n/gi, (_match, kind, r, g, b, scheme) => {
    if (scheme) { state.reports.push(Number(scheme)); process.stdout.write(queries); }
    else state.colors[kind] = rgb([r,g,b]);
    return '';
  }).slice(-8192);
  fs.writeFileSync(${JSON.stringify(probeState)}, JSON.stringify(state));
});
process.stdout.write('\x1b[2J\x1b[HTheme query probe\r\n\x1b[?2031h\x1b[?996n' + queries);
`);
  await paneSendText(pane, `node '${probe}'\r`);
  for (const mode of ["dark", "light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    const theme = expected("amber", mode);
    await until(() => {
      const state = read(probeState);
      return same(state?.colors?.["10"], theme.foreground) && same(state?.colors?.["11"], theme.background)
        && same(state?.colors?.["4"], theme.palette[4]) && state?.reports?.at(-1) === (mode === "dark" ? 1 : 2);
    }, `OSC defaults/palette and scheme follow ${mode}`);
    console.log(`PASS real PTY: ${mode} foreground/background/ANSI and subscribed scheme report`);
  }
  const reports = read(probeState)!.reports.length;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Appearance");
  await page.locator("#settings-theme-dark").selectOption("tokyo-night");
  const tokyo = expected("tokyo-night", "dark");
  await until(() => same(read(probeState)?.colors?.["11"], tokyo.background) && read(probeState)!.reports.length > reports,
    "same-appearance palette change sends a refresh notification");
  console.log("PASS same-appearance Tokyo Night switch refreshes the application palette");
  const separate = ghosttyThemeNames().find((name) => /^dracula$/i.test(name));
  assert(separate, "a distinct built-in Ghostty palette is available");
  await page.locator("#settings-terminal-theme").selectOption(separate);
  const ghostty = expected("tokyo-night", "dark", separate);
  await until(() => same(read(probeState)?.colors?.["11"], ghostty.background)
    && same(read(probeState)?.colors?.["4"], ghostty.palette[4]), "separate Ghostty palette reaches queries");
  await page.locator("#settings-terminal-theme").selectOption("");
  await until(() => same(read(probeState)?.colors?.["11"], tokyo.background), "Match the app restores the app palette");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS separate Ghostty terminal theme and return to Match the app");
  await paneSendText(pane, "x");
  await until(() => existsSync(join(root, "probe-done")), "query probe exits");

  const pi = process.env["PI_THEME_QA_BIN"];
  if (pi) {
    const config = join(root, "pi-config");
    await Bun.write(join(config, "settings.json"), JSON.stringify({ theme: "system", quietStartup: true, packages: [] }));
    const extension = join(root, "pi-theme-probe.ts");
    writeFileSync(extension, `import { writeFileSync } from 'node:fs';
export default function (pi) {
  let timer;
  pi.on('session_start', (_event, ctx) => {
    let previous = '';
    const save = () => {
      const theme = ctx.ui.theme;
      const next = JSON.stringify({ name: theme.name, appearance: theme.appearance, text: theme.colors.text, panel: theme.colors.userMessageBg, accent: theme.colors.accent });
      if (next !== previous) { previous = next; writeFileSync(${JSON.stringify(piState)}, next); }
    };
    ctx.ui.setWidget('theme-probe', () => ({ render() { return [ctx.ui.theme.bg('userMessageBg', ctx.ui.theme.fg('userMessageText', ' System theme preview '))]; }, invalidate() {} }));
    save(); timer = setInterval(save, 50);
  });
  pi.on('session_shutdown', () => clearInterval(timer));
}`);
    await paneSendText(pane, `PI_CODING_AGENT_DIR='${config}' PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 '${pi}' --offline --no-tools --no-session -ne -ns -np --no-themes -nc -na --use-theme system -e '${extension}'\r`);
    for (const mode of ["dark", "light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      const theme = expected(mode === "dark" ? "tokyo-night" : "tokyo-night-day", mode);
      await until(() => {
        const state = read(piState);
        if (state?.name !== "system" || state.appearance !== mode || state.text?.kind !== "rgb" || state.panel?.kind !== "rgb") return false;
        const text = luminance(state.text), panel = luminance(state.panel);
        // Pi deliberately adjusts foreground lightness to keep contrast on every derived panel.
        return (Math.max(text, panel) + 0.05) / (Math.min(text, panel) + 0.05) >= 4.5
          && (mode === "light" ? text < panel : same({ r: state.text.r, g: state.text.g, b: state.text.b }, theme.foreground));
      }, `Pi system theme follows ${mode} with readable RGB panel colours`);
      await page.screenshot({ path: join(evidence, `pi-${mode}.png`), animations: "disabled" });
      console.log(`PASS actual Pi: ${mode}, RGB panels follow the terminal with at least 4.5:1 text contrast`);
    }
    const before = JSON.stringify(read(piState)?.panel);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await openSettingsPage(page, "Appearance");
    await page.locator("#settings-theme-dark").selectOption("amber");
    const amber = expected("amber", "dark");
    await until(() => {
      const state = read(piState);
      return state?.appearance === "dark" && state.text?.kind === "rgb"
        && same({ r: state.text.r, g: state.text.g, b: state.text.b }, amber.foreground)
        && JSON.stringify(state.panel) !== before;
    }, "actual Pi refreshes after a same-appearance palette switch");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.screenshot({ path: join(evidence, "pi-amber.png"), animations: "disabled" });
    console.log("PASS actual Pi refreshes same-appearance palette changes too");
  } else console.log("SKIP actual Pi (set PI_THEME_QA_BIN to an installed pi executable)");
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser.close();
  if (workspace) await workspaceClose(workspace);
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
