import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { failureSite, scriptOutcome, selectBrowserScripts, serialBrowserScripts } from "./ci-browser-parallel.ts";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("Browser failure sites", () => {
  it("returns no failure for PASS lines", () => {
    expect(failureSite("PASS scripts/ui-regression.ts\nPASS all checks")).toEqual({ site: null, message: null });
  });
  it("reads the first assertion frame after the error", () => {
    const log = `65 | assert(Date.now() < deadline, "input regression timed out");
                                    ^
AssertionError: input regression timed out
 generatedMessage: false,
      at /w/t-rex/t-rex/scripts/terminal-input-regression.ts:65:32
      at checkTerminalInput (/w/t-rex/t-rex/scripts/terminal-input-regression.ts:81:11)`;
    expect(failureSite(log)).toEqual({ site: "scripts/terminal-input-regression.ts:65", message: "AssertionError: input regression timed out" });
  });
  it("skips Playwright frames for the first script frame", () => {
    const log = `  TimeoutError: waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('.prompt-card') to be detached
      at /w/t-rex/t-rex/node_modules/playwright-core/lib/coreBundle.js:57694:13
      at checkSplitView (/w/t-rex/t-rex/scripts/split-view-regression.ts:509:13)`;
    expect(failureSite(log)).toEqual({ site: "scripts/split-view-regression.ts:509", message: "TimeoutError: waitFor: Timeout 30000ms exceeded." });
  });
  it("keeps an error with no script frame", () => {
    expect(failureSite("TypeError: broken\n  at /tmp/node_modules/scripts/helper.ts:2:1")).toEqual({ site: null, message: "TypeError: broken" });
  });
});

function indentedSection(source: string, parent: string, name: string, indent: number): string {
  const lines = source.split("\n");
  const parentLine = lines.indexOf(`${" ".repeat(indent - 2)}${parent}:`);
  if (parentLine < 0) throw new Error(`Missing ${parent} section`);
  const prefix = " ".repeat(indent);
  const start = lines.indexOf(`${prefix}${name}:`, parentLine + 1);
  if (start < 0) throw new Error(`Missing ${name} in ${parent}`);
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (new RegExp(`^${prefix}[^\\s#][^:]*:`).test(lines[end] ?? "")) break;
  }
  return lines.slice(start, end).join("\n");
}

const ciJob = (name: string): string => indentedSection(ci, "jobs", name, 2);

describe("CI reports", () => {
  it("keeps reports and nested verification evidence for CI jobs on success or failure", () => {
    expect(ciJob("fast")).toContain("CHECK_DIR: ${{ github.workspace }}/.ci");
    expect(ciJob("integration")).toContain("CHECK_DIR: ${{ github.workspace }}/.ci");
    const fast = ciJob("fast");
    expect(fast).toContain(".ci/report.json");
    expect(fast).toContain("if: always()");
    expect(fast).toContain(".ci/**/*.log");
    expect(fast).toContain(".ci/browser-evidence/**/*.png");
    expect(fast).toContain(".ci/browser-evidence/**/*.json");
    expect(fast).toContain(".ci/browser-evidence/**/*.zip");
    const integration = ciJob("integration");
    expect(integration).toContain(".ci/report.json");
    expect(integration).toContain("if: always()");
    expect(integration).toContain(".ci/**/*.log");
    expect(integration).toContain(".ci/config/herdr/sessions/*/test-server.log");
    for (const name of ["browser-main", "browser-other"]) {
      const job = ciJob(name);
      expect(job).toContain("if: always()");
      expect(job).toContain(".ci/browser-logs/**");
      expect(job).toContain(".ci/browser-evidence/**/*.png");
      expect(job).toContain(".ci/browser-evidence/**/*.json");
      expect(job).toContain(".ci/browser-evidence/**/*.zip");
    }
  });
});

describe("Browser lane script lists", () => {
  const serial = serialBrowserScripts();
  const env = (job: string, name: string) => job.match(new RegExp(`^\\s+${name}: (.+)$`, "m"))?.[1];

  it("reads every script the serial lane runs, and only those", () => {
    const sh = readFileSync(new URL("./ci-browser.sh", import.meta.url), "utf8");
    const runs = [...sh.matchAll(/^run_script (\S+)/gm)].map((match) => match[1]).filter((script) => script !== "scripts/demo-build.ts");
    expect(serial).toEqual(runs);
    expect(serial).toContain("scripts/ui-regression.ts");
    expect(serial).toContain("scripts/ui-contexts-regression.ts");
    expect(new Set(serial).size).toBe(serial.length);
  });

  it("splits the serial lane across the CI browser jobs with nothing dropped or run twice", () => {
    const shards = ["browser-main", "browser-other"].map((name) => {
      const job = ciJob(name);
      expect(job).toContain("run: bun run check run -- bun scripts/ci-browser-parallel.ts");
      return selectBrowserScripts(serial, env(job, "BROWSER_SCRIPTS"), env(job, "BROWSER_EXCLUDE"));
    });
    const all = shards.flat();
    expect(all.length).toBe(serial.length);
    expect([...all].sort()).toEqual([...serial].sort());
  });

  it("runs every herdr-backed lane under a shared check slot that it waits for", () => {
    expect(ciJob("integration")).toContain("run: bun run check integration");
    for (const name of ["integration", "browser-main", "browser-other"]) {
      const job = ciJob(name);
      expect(env(job, "CHECK_MAX_RUNS")).toMatch(/^[1-8]$/);
      const wait = Number(env(job, "CHECK_WAIT_SECONDS"));
      const timeout = Number(job.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
      expect(wait).toBeGreaterThan(0);
      // the job outlives its longest wait, with room for the lane itself
      expect(timeout * 60).toBeGreaterThanOrEqual(wait + 600);
    }
  });

  it("calls a script that passed only on its second run flaky, and one that failed again a failure", () => {
    expect(scriptOutcome(0, false)).toBe("pass");
    expect(scriptOutcome(0, true)).toBe("flaky");
    expect(scriptOutcome(1, true)).toBe("fail");
    expect(scriptOutcome(1, false)).toBe("fail");
  });

  it("refuses a script name the serial lane does not run", () => {
    expect(() => selectBrowserScripts(serial, "scripts/missing-regression.ts")).toThrow("scripts/missing-regression.ts");
    expect(() => selectBrowserScripts(serial, undefined, "scripts/missing-regression.ts")).toThrow("scripts/missing-regression.ts");
    expect(selectBrowserScripts(serial, undefined, "scripts/ui-regression.ts")).toEqual(serial.filter((script) => script !== "scripts/ui-regression.ts"));
  });

  it("runs both isolated UI flows in browser-main and keeps the local UI command complete", () => {
    const main = ciJob("browser-main");
    expect(selectBrowserScripts(serial, env(main, "BROWSER_SCRIPTS"))).toEqual([
      "scripts/ui-regression.ts", "scripts/ui-contexts-regression.ts",
    ]);
    expect(env(main, "BROWSER_WORKERS")).toBe("2");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const script of ["ui-regression.ts", "ui-contexts-regression.ts", "sticky-modifiers-regression.ts"]) {
      expect(pkg.scripts["test:ui"]).toContain(`bun scripts/${script}`);
    }
  });

  it("uses existing isolated worker controls without increasing hosted integration concurrency", () => {
    expect(env(ciJob("integration"), "HERDR_TEST_SHARDS"))
      .toBe("${{ runner.environment == 'self-hosted' && '4' || '1' }}");
    expect(env(ciJob("browser-other"), "BROWSER_WORKERS"))
      .toBe("${{ runner.environment == 'self-hosted' && '6' || '4' }}");
  });
});

describe("Extracted UI checks", () => {
  it("refuses a direct mobile viewport run in unit mode instead of silently passing", () => {
    // Given a unit run, no browser or herdr fixture is allowed.
    // When the shared helper is invoked directly, it must execute its entrypoint.
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./mobile-viewport-regression.ts", import.meta.url))], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, HERDR_TEST_MODE: "unit" },
    });
    // Then the unit-mode guard rejects the run rather than returning an empty success.
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HERDR_TEST_MODE=unit");
  });

  const moved = [
    "checkPushSettings", "checkWakeLock", "checkSecretInput", "checkTerminalCopy", "checkPaneFind",
    "checkNotificationStartup", "checkNotificationView", "checkMobileViewport",
    "checkTerminalPinch", "checkMobileTabs", "checkTabMenu", "checkDefaultView",
    "checkComposerReconnect", "checkSplitView", "checkTakeOver",
    "checkChatKeepsTerminalSize", "checkPaneSwitchKeepsTerminalSize",
    "checkBackgroundTabKeepsTerminalSize", "checkFocusedWindowReclaimsTerminalSize",
    "checkUpdateNotice",
  ];
  const calls = (source: string) => [...source.matchAll(/\b(check[A-Z]\w*)\(/g)].map((match) => match[1]!);

  it("moves all 21 existing checks exactly once, in order, without removing core input checks", () => {
    const core = calls(readFileSync(new URL("./ui-regression.ts", import.meta.url), "utf8"));
    const contexts = calls(readFileSync(new URL("./ui-contexts-checks.ts", import.meta.url), "utf8"));
    expect(contexts.filter((name) => moved.includes(name))).toEqual(moved);
    expect(core.filter((name) => moved.includes(name))).toEqual([]);
    for (const name of ["checkTerminalInput", "checkSafariIme", "checkHeldDraftPaneSwitch",
      "checkCommandBackspace", "checkCtrlEnter", "checkCommandArrows"]) {
      expect(core.filter((call) => call === name)).toHaveLength(1);
    }
  });

  for (const mode of ["unit", "live"] as const) {
    it(`refuses ${mode} execution before touching a herdr daemon`, () => {
      const root = mkdtempSync(join(tmpdir(), "ui-context-guard-"));
      try {
        const invoked = join(root, "invoked");
        const herdr = join(root, "herdr");
        writeFileSync(herdr, '#!/bin/sh\nprintf called > "$HERDR_GUARD_LOG"\nexit 1\n', { mode: 0o700 });
        const result = spawnSync(process.execPath, [fileURLToPath(new URL("./ui-contexts-regression.ts", import.meta.url))], {
          encoding: "utf8", timeout: 5_000,
          env: {
            ...process.env, TMPDIR: root, XDG_CONFIG_HOME: root,
            HERDR_WEB_HERDR_BIN: herdr, HERDR_GUARD_LOG: invoked,
            HERDR_SOCKET: join(root, "no-parent.sock"),
            HERDR_TEST_MODE: mode === "unit" ? "unit" : "integration",
            HERDR_TEST_LIVE: mode === "live" ? "1" : "",
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr.toLowerCase()).toContain(mode);
        expect(existsSync(invoked)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
