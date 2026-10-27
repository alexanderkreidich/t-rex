import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { applyDiff, frameText, PLAIN_STYLE, type Style } from "../../shared/ssp.ts";
import { Screen } from "../ssp/screen.ts";
import { connectionData, type Client } from "./connections.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { TerminalDisplayTheme } from "../../shared/terminal-theme.ts";
import * as herdr from "../herdr/client.ts";

let attachment: PaneAttachment;
let broadcast: (pane: string, message: ServerMessage) => void;
mock.module("./terminal-process.ts", () => ({
  ATTACH_HELD_MESSAGE: "Held",
  createSpawnAttachment: (options: { attachments: Map<string, PaneAttachment>; broadcast: typeof broadcast }) => {
    broadcast = options.broadcast;
    return { spawnAttachment: async (pane: string) => { options.attachments.set(pane, attachment); return attachment; } };
  },
}));
const { createTerminalRegistry } = await import("./terminals.ts");

afterEach(() => mock.restore());

for (const sync of [true, false]) for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`preserves input readiness ${ready} after the screen for an ${readOnly ? "observer" : "owner"} joining a shared attach${sync ? "" : " on the raw stream"}`, async () => {
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
      close() {},
    } as unknown as Client;
    const screen = await Screen.create(80, 24);
    screen.write("retained screen");
    attachment = {
      kind: "pty", ready, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), screen, resumable: new Map(),
      process: { exited: Promise.resolve(), resize() {}, kill() {}, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
    };
    const registry = createTerminalRegistry({
      options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
      holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
      end() {},
    });
    await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true, ...(sync ? { sync: "ssp" as const } : {}) });
    const output = frames.findIndex((frame) => frame.type === (sync ? "ssp" : "pty-data"));
    expect(output).toBeGreaterThanOrEqual(0);
    const first = frames[output]!;
    if (first.type === "ssp") {
      const styles = new Map<number, Style>([[0, PLAIN_STYLE]]);
      expect(frameText(applyDiff(null, first, styles))[0]).toBe("retained screen");
    } else if (first.type === "pty-data") {
      // an older page gets the screen drawn whole
      expect(first.data).toContain("retained screen");
    }
    // An input-ready receipt is the existing attach-complete barrier for queued input,
    // not an output-presentation notification. No early negative receipt may satisfy it.
    expect(frames.filter((frame) => frame.type === "input-ready")).toEqual(
      ready ? [{ type: "input-ready", pane_id: "p" }] : [],
    );
    if (ready) expect(frames.findIndex((frame) => frame.type === "input-ready")).toBeGreaterThan(output);
    registry.closeAttachment("p");
  });
}

const palette = (background: number): TerminalDisplayTheme => ({
  foreground: { r: 192, g: 202, b: 245 }, background: { r: background, g: background, b: background },
  palette: Array.from({ length: 16 }, () => ({ r: 122, g: 162, b: 247 })),
});

async function themeFixture(ready = true) {
  const screen = await Screen.create(80, 24);
  const writes: string[] = [];
  attachment = {
    kind: "pty", terminalId: "term_test", ready, cols: 80, rows: 24,
    clients: new Set(), grids: new Map(), stalled: new Map(), screen, resumable: new Map(),
    process: { exited: Promise.resolve(), resize() {}, kill() {}, write(data: string) { writes.push(data); } } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
  };
  const clients = new Set<Client>();
  const client = (readOnly = false) => {
    const socket = {
      data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send: (text: string) => text.length, close() {},
    } as unknown as Client;
    clients.add(socket);
    return socket;
  };
  const registry = createTerminalRegistry({
    options: {}, clients, stopped: () => false, terminalAttach: async () => true,
    holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0, end() {},
  });
  return { client, registry, writes, frames: registry.terminalFrames };
}

it("publishes only the active operator's theme and restores the previous operator on release", async () => {
  const restored = Promise.withResolvers<void>();
  const published: (TerminalDisplayTheme | null)[] = [];
  spyOn(herdr, "terminalSetTheme").mockImplementation(async (_id, theme, guard) => {
    if (guard()) { published.push(theme); if (published.length === 3) restored.resolve(); }
  });
  const { client, frames, registry, writes } = await themeFixture();
  const a = client(), b = client(), observer = client(true);
  const dark = palette(26), light = palette(240);
  const attach = (socket: Client, theme: TerminalDisplayTheme, keep_size = false) => frames.attach(socket, { type: "attach", pane_id: "p", cols: 80, rows: 24, theme, keep_size });
  try {
    await attach(a, dark);
    await attach(observer, light);
    await attach(b, light, true);
    expect(published).toEqual([dark]);
    await frames.resize(observer, { type: "resize", pane_id: "p", cols: 80, rows: 24, theme: light });
    expect(published).toEqual([dark]);
    await frames.resize(b, { type: "resize", pane_id: "p", cols: 80, rows: 24, theme: light });
    expect(published).toEqual([dark, light]);
    frames["release-size"](b, { type: "release-size", pane_id: "p" });
    await restored.promise;
    expect(published).toEqual([dark, light, dark]);
    expect(writes).toEqual([]);
  } finally { registry.closeAttachment("p"); }
});

it("does not lose an equal palette when its original publisher loses ownership during the write", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const published: (TerminalDisplayTheme | null)[] = [];
  spyOn(herdr, "terminalSetTheme").mockImplementation(async (_id, theme, guard) => {
    started.resolve();
    await release.promise;
    if (guard()) { published.push(theme); applied.resolve(); }
  });
  const { client, frames, registry } = await themeFixture();
  const a = client(), b = client(), dark = palette(26);
  try {
    await frames.attach(a, { type: "attach", pane_id: "p", cols: 80, rows: 24, theme: dark });
    await started.promise;
    await frames.attach(b, { type: "attach", pane_id: "p", cols: 80, rows: 24, theme: structuredClone(dark) });
    release.resolve();
    await applied.promise;
    expect(published).toEqual([dark]);
  } finally { release.resolve(); registry.closeAttachment("p"); }
});

it("waits for attach readiness and republishes after the underlying process changes", async () => {
  let applied = Promise.withResolvers<void>();
  const published: (TerminalDisplayTheme | null)[] = [];
  spyOn(herdr, "terminalSetTheme").mockImplementation(async (_id, theme, guard) => {
    if (guard()) { published.push(theme); applied.resolve(); }
  });
  const { client, frames, registry } = await themeFixture(false);
  const dark = palette(26);
  try {
    await frames.attach(client(), { type: "attach", pane_id: "p", cols: 80, rows: 24, theme: dark });
    expect(published).toEqual([]);
    attachment.ready = true;
    broadcast("p", { type: "input-ready", pane_id: "p" });
    await applied.promise;
    expect(published).toEqual([dark]);
    applied = Promise.withResolvers<void>();
    attachment.process = { ...attachment.process } as typeof attachment.process;
    broadcast("p", { type: "input-ready", pane_id: "p" });
    await applied.promise;
    expect(published).toEqual([dark, dark]);
  } finally { registry.closeAttachment("p"); }
});
