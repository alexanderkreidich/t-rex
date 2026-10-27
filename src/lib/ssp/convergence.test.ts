/**
 * The whole path, end to end: the bridge's screen (server/ssp/screen.ts) synced by its sender
 * (server/ssp/sync.ts) over a link that delays, reorders and drops frames and acknowledgements, into
 * the browser's view (view.ts), drawn into a second headless terminal standing in for the renderer.
 * Once the program stops drawing, the renderer must show exactly the bridge's screen.
 */
import { describe, expect, it } from "bun:test";
import { decodeRow, styleKey, type Frame, type FrameDiff, type Style } from "../../../shared/ssp.ts";
import { Screen } from "../../../server/ssp/screen.ts";
import { SyncSender, type SyncResume } from "../../../server/ssp/sync.ts";
import { SspView } from "./view.ts";

/** A seeded PRNG (mulberry32), so a failure replays. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Link { latency: number; jitter: number; loss: number }

/** Delivers after latency ± jitter (so out of order), or drops; nothing goes once it is cut. */
function channel<T>(link: Link, next: () => number, deliver: (message: T) => void) {
  let cut = false;
  return {
    send(message: T): boolean {
      if (cut) return false;
      if (next() < link.loss) return true;
      const copy = JSON.parse(JSON.stringify(message)) as T;
      setTimeout(() => { if (!cut) deliver(copy); }, link.latency + (next() * 2 - 1) * link.jitter);
      return true;
    },
    cut() { cut = true; },
  };
}

function cellsOf(frame: Frame, styleOf: (id: number) => Style): string[] {
  return frame.lines.map((line) => decodeRow(line.wire, frame.cols).map((cell) => `${cell.text}/${cell.width}/${styleKey(styleOf(cell.style))}`).join("|"));
}

const PIECES = [
  "hello", "\x1b[31mred\x1b[0m", "\x1b[1;4mbold\x1b[0m", "\x1b[38;2;10;200;30mrgb\x1b[m", "\x1b[44m  \x1b[K\x1b[0m", "中文", "👨‍👩‍👧", "é",
  "\r\n", "\r\n", "\x1b[H", "\x1b[2J", "\x1b[3;5H", "\x1b[K", "\x1b[?1000h", "\x1b[?1000l", "\x1b[?2004h", "\x1b[?25l", "\x1b[?25h",
  "\x1b[5 q", "\x1b]8;;https://example.com\x07link\x1b]8;;\x07", "\x1b[2A", "\x1b[7mrev\x1b[27m", "tab\tx",
];

/** Output like `cat`-ing a file: lines scrolling up from the bottom. */
const SCROLLING = ["line one\r\n", "\x1b[32mline two\x1b[0m\r\n", "a longer line of text that wraps around the edge\r\n", "x\r\n"];

async function run(seed: number, link: Link, steps: number, reconnectAt: number | null, pieces = PIECES): Promise<void> {
  const next = random(seed);
  const cols = 30, rows = 8;
  const bridge = await Screen.create(cols, rows);
  const renderer = await Screen.create(cols, rows);
  let sender: SyncSender;
  let toClient: ReturnType<typeof channel<FrameDiff>>;
  let toBridge: ReturnType<typeof channel<{ stream: string; num: number }>>;
  const view = new SspView({
    write: (data) => { renderer.write(data); },
    ack: (stream, num) => { toBridge.send({ stream, num }); },
  });
  view.setPredicting(false);
  view.setSize(cols, rows);
  const connect = (resume?: SyncResume, num?: number): void => {
    toClient = channel<FrameDiff>(link, next, (diff) => view.receive(diff));
    toBridge = channel<{ stream: string; num: number }>(link, next, (ack) => { if (ack.stream === sender.stream) sender.ack(ack.num); });
    const base = resume && num !== undefined ? resume.frames.get(num) : undefined;
    sender = new SyncSender(bridge, { send: (diff) => toClient.send(diff), buffered: () => 0, echo: () => 0 }, base ? { stream: resume!.stream, base } : undefined);
    sender.schedule();
  };
  connect();
  for (let step = 0; step < steps; step++) {
    let chunk = "";
    for (let i = 0, n = 1 + Math.floor(next() * 4); i < n; i++) chunk += pieces[Math.floor(next() * pieces.length)];
    bridge.write(chunk);
    sender!.schedule();
    if (step === reconnectAt) {
      // the connection drops; the client comes back naming the newest screen it has
      toClient!.cut();
      toBridge!.cut();
      const resume = sender!.resumable() ?? undefined;
      sender!.dispose();
      connect(resume, view.screen?.num);
    }
    // fixed wait: the program's output comes spread out in time, as a pane's does
    await Bun.sleep(next() * 6);
  }
  const deadline = Date.now() + 15_000;
  const want = () => cellsOf(bridge.frame(), (id) => bridge.styleOf(id)).join("\n");
  const have = () => cellsOf(renderer.frame(), (id) => renderer.styleOf(id)).join("\n");
  while (Date.now() < deadline && (view.screen?.num !== bridge.version || want() !== have())) await Bun.sleep(20);
  const target = bridge.frame();
  const shown = renderer.frame();
  expect(have()).toBe(want());
  expect(shown.cursor).toEqual(target.cursor);
  expect(shown.modes).toEqual(target.modes);
  sender!.dispose();
  view.dispose();
  bridge.dispose();
  renderer.dispose();
}

describe("the screen converges to the bridge's", () => {
  it("over a clean link", () => run(1, { latency: 5, jitter: 0, loss: 0 }, 150, null), 30_000);
  it("over a slow link (200 ms round trip)", () => run(2, { latency: 100, jitter: 10, loss: 0 }, 60, null), 30_000);
  it("under loss and reordering", () => run(3, { latency: 20, jitter: 15, loss: 0.2 }, 120, null), 30_000);
  it("across a reconnect under loss", () => run(4, { latency: 15, jitter: 10, loss: 0.15 }, 120, 60), 30_000);
  it("while the screen scrolls", () => run(5, { latency: 10, jitter: 5, loss: 0.1 }, 150, 75, SCROLLING), 30_000);
  for (const seed of [11, 12, 13]) it(`under heavy loss (seed ${seed})`, () => run(seed, { latency: 10, jitter: 10, loss: 0.4 }, 80, 40), 30_000);
});
