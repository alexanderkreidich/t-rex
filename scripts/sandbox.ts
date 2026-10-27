/**
 * A disposable herdr and bridge for UI work. Nothing here reaches the herdr you work in:
 * the herdr session is `restty-sandbox` (HERDR_TEST_SESSION overrides), started headless with
 * empty shell startup files (scripts/test-herdr.ts), and the bridge keeps its state in a temp dir.
 *
 *   bun run sandbox                     bridge on 127.0.0.1:7417 (SANDBOX_PORT); pair it with
 *                                       `HERDR_WEB_API_PORT=7417 bun run dev` for Vite with HMR
 *   bun run sandbox --shot out.png      screenshot the built app (`bun run build` first) and exit
 *       [--size 1440x900] [--wait 1500] [--theme dark|light]
 *
 * Stop the herdr session when done: `herdr --session restty-sandbox server stop`.
 */
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

process.env["HERDR_TEST_SESSION"] ||= "restty-sandbox";
const root = realpathSync(mkdtempSync(join(tmpdir(), "restty-sandbox-")));
process.env["HERDR_WEB_STATE_DIR"] ||= join(root, "web-state");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!process.env["CHROME_PATH"] && existsSync(MAC_CHROME)) process.env["CHROME_PATH"] = MAC_CHROME;

// imported after the environment above: test-herdr.ts reads the session name when it loads
await import("./test-herdr.ts");
const { herdrRpc, sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } = await import("../server/herdr/client.ts");
const { createServer } = await import("../server/index.ts");

const repo = realpathSync(join(import.meta.dir, ".."));
const SEED_LABEL = "t-rex";

/** One workspace with a few tabs, made once per herdr session and reused after. */
async function seed(): Promise<void> {
  const snapshot = await sessionSnapshot();
  // test-herdr.ts keeps a resident workspace in an empty session; the seed stands in for it
  const resident = snapshot.workspaces.filter((workspace) => workspace.label === "t-rex-test-resident");
  if (snapshot.workspaces.some((workspace) => workspace.label === SEED_LABEL)) {
    for (const workspace of resident) await workspaceClose(workspace.workspace_id);
    return;
  }
  const created = await workspaceCreate({ cwd: repo, label: SEED_LABEL });
  const workspaceId = created.workspace.workspace_id;
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: "git log --oneline -12\r" });
  const second = await tabCreate({ workspaceId, cwd: join(repo, "src") });
  await herdrRpc("pane.send_text", { pane_id: second.root_pane.pane_id, text: "ls components | head -40\r" });
  await tabCreate({ workspaceId, cwd: join(repo, "server") });
  for (const workspace of resident) await workspaceClose(workspace.workspace_id);
}

await seed();
const port = flag("--shot") === undefined ? Number(process.env["SANDBOX_PORT"] ?? 7417) : 0;
const server = createServer({ port, hostname: "127.0.0.1", token: "", stateDir: join(root, "push") });
const origin = `http://127.0.0.1:${server.port}`;

const shot = flag("--shot");
if (shot === undefined) {
  console.log(`sandbox: herdr session ${process.env["HERDR_TEST_SESSION"]}, bridge ${origin}`);
  console.log(`sandbox: built app at ${origin}; Vite with HMR: HERDR_WEB_API_PORT=${server.port} bun run dev`);
  const stop = (): void => { server.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  const [width, height] = (flag("--size") ?? "1440x900").split("x").map(Number) as [number, number];
  const { chromium } = await import("playwright-core");
  const { chromePath } = await import("./chrome-path.ts");
  const browser = await chromium.launch({ executablePath: chromePath(), args: ["--lang=en-US"] });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: flag("--theme") === "light" ? "light" : "dark", locale: "en-US" });
    await page.addInitScript((theme) => localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en", theme })), flag("--theme") === "light" ? "light" : "dark");
    await page.goto(origin);
    await page.waitForSelector(".terminal-host", { timeout: 20_000 });
    await page.waitForTimeout(Number(flag("--wait") ?? 1500));
    await page.screenshot({ path: shot });
    console.log(`sandbox: ${shot} (${width}x${height})`);
  } finally {
    await browser.close();
    server.stop();
  }
  process.exit(0);
}
