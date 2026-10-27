import { describe, expect, it } from "bun:test";
import { applyDiff, frameText, PLAIN_STYLE, type Frame, type FrameDiff, type Style } from "../../shared/ssp.ts";
import { Screen } from "./screen.ts";
import { ECHO_DELAY_MS, EchoClock, SEND_INTERVAL_MIN_MS, SEND_MIN_DELAY_MS, SyncSender } from "./sync.ts";

/** A client that applies what it is sent, like the browser's view. */
function receiver() {
  const styles = new Map<number, Style>([[0, PLAIN_STYLE]]);
  const frames = new Map<number, Frame>();
  const state = { newest: null as Frame | null, dropped: 0 };
  return {
    state,
    apply(diff: FrameDiff): Frame | null {
      const base = diff.base === 0 ? null : frames.get(diff.base);
      if (diff.base !== 0 && !base) {
        state.dropped++;
        return null;
      }
      const frame = applyDiff(base ?? null, diff, styles);
      frames.set(frame.num, frame);
      for (const num of frames.keys()) if (num < diff.throwaway && num !== frame.num) frames.delete(num);
      if (!state.newest || frame.num > state.newest.num) state.newest = frame;
      return frame;
    },
  };
}

/** A screen the attach has drawn on: before that, a sender sends nothing. */
async function drawn(cols = 20, rows = 4): Promise<Screen> {
  const screen = await Screen.create(cols, rows);
  screen.write(" \r");
  return screen;
}

async function until(check: () => boolean, label: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(2);
  }
}

describe("SyncSender", () => {
  it("sends nothing before the attach has drawn", async () => {
    const screen = await Screen.create(20, 4);
    const sent: FrameDiff[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    screen.resize(30, 5);
    sender.schedule();
    expect(sent).toEqual([]);
    screen.write("$ ");
    sender.schedule();
    expect(sent).toHaveLength(1);
    sender.dispose();
    screen.dispose();
  });

  it("sends the first screen at once and whole, then differences from the newest sent", async () => {
    const screen = await Screen.create(20, 4);
    screen.write("hello");
    const sent: FrameDiff[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.base).toBe(0);
    expect(sent[0]!.lines.map(([row]) => row)).toEqual([0]);
    screen.write(" world");
    sender.schedule();
    // output that follows within the minimum delay joins the same frame
    expect(sent).toHaveLength(1);
    screen.write("!");
    await until(() => sent.length === 2, "the second frame");
    expect(sent[1]!.base).toBe(sent[0]!.num);
    const client = receiver();
    client.apply(sent[0]!);
    expect(frameText(client.apply(sent[1]!)!)[0]).toBe("hello world!");
    sender.dispose();
    screen.dispose();
  });

  it("skips the screens in between: latest state wins", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    for (let i = 0; i < 500; i++) {
      screen.write(`\r${i}`);
      sender.schedule();
    }
    // fixed wait: every frame the pace allows goes in this time; the test counts how few that is
    await Bun.sleep(SEND_MIN_DELAY_MS + SEND_INTERVAL_MIN_MS * 3);
    expect(sent.length).toBeLessThan(5);
    const client = receiver();
    for (const diff of sent) client.apply(diff);
    expect(frameText(client.state.newest!)[0]).toBe("499");
    sender.dispose();
    screen.dispose();
  });

  it("waits for an acknowledgement after a few unacknowledged screens", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    for (let i = 0; i < 40; i++) {
      screen.write(`\r${i}`);
      sender.schedule();
      await Bun.sleep(SEND_INTERVAL_MIN_MS + 2);
    }
    expect(sent.length).toBeLessThanOrEqual(8);
    // the acknowledgement of the newest lets the current screen go at once, from it
    const newest = sent.at(-1)!;
    expect(sender.ack(newest.num)).toBe(true);
    await until(() => sent.length > 8 || sent.at(-1)!.base === newest.num, "the next frame after the acknowledgement");
    const last = sent.at(-1)!;
    expect(last.base).toBe(newest.num);
    expect(last.throwaway).toBe(newest.num);
    sender.dispose();
    screen.dispose();
  });

  it("refuses an acknowledgement of a screen never sent, and takes a stale one quietly", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    expect(sender.ack(sent[0]!.num + 100)).toBe(false);
    expect(sender.ack(1.5)).toBe(false);
    expect(sender.ack(sent[0]!.num)).toBe(true);
    expect(sender.ack(sent[0]!.num)).toBe(true);
    expect(sender.ack(0)).toBe(true);
    sender.dispose();
    screen.dispose();
  });

  it("measures the round trip and paces frames by it", async () => {
    const screen = await drawn();
    const sent: { diff: FrameDiff; at: number }[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push({ diff, at: Date.now() }); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    // fixed wait: the round trip being measured
    await Bun.sleep(60);
    sender.ack(sent[0]!.diff.num);
    expect(sender.rtt).toBeGreaterThanOrEqual(55);
    // half a round trip between frames
    for (let i = 0; i < 3; i++) {
      screen.write(`${i}`);
      sender.schedule();
      await until(() => sent.length === i + 2, "a frame");
      sender.ack(sent.at(-1)!.diff.num);
    }
    const gaps = sent.slice(1).map((entry, i) => entry.at - sent[i]!.at);
    for (const gap of gaps.slice(1)) expect(gap).toBeGreaterThanOrEqual(15);
    expect(sent.at(-1)!.diff.rtt).toBeGreaterThan(40);
    sender.dispose();
    screen.dispose();
  });

  it("sends again from the acknowledged screen when an acknowledgement is overdue", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    sender.schedule();
    sender.ack(sent[0]!.num);
    screen.write("lost");
    sender.schedule();
    await until(() => sent.length === 2, "the frame that gets lost");
    // no acknowledgement: after the timeout it goes again, from the acknowledged base
    await until(() => sent.length === 3, "the retransmission", 3000);
    expect(sent[2]!.base).toBe(sent[0]!.num);
    expect(sent[2]!.num).toBe(sent[1]!.num);
    sender.dispose();
    screen.dispose();
  });

  it("holds frames while the connection's queue is full", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    let buffered = 10 * 1024 * 1024;
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => buffered, echo: () => 0 });
    sender.schedule();
    expect(sent).toHaveLength(0);
    buffered = 0;
    sender.drain();
    expect(sent).toHaveLength(1);
    sender.dispose();
    screen.dispose();
  });

  it("sends a frame when only the echo moved", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    let echo = 0;
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => echo });
    sender.schedule();
    sender.ack(sent[0]!.num);
    echo = 3;
    sender.schedule();
    await until(() => sent.length === 2, "the echo frame");
    expect(sent[1]!.echo).toBe(3);
    expect(sent[1]!.lines).toEqual([]);
    sender.dispose();
    screen.dispose();
  });

  it("sends an acknowledged echo frame only once", async () => {
    const screen = await drawn();
    const sent: FrameDiff[] = [];
    let echo = 0;
    const sender = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => echo });
    sender.schedule();
    sender.ack(sent[0]!.num);
    echo = 1;
    sender.schedule();
    await until(() => sent.length === 2, "the echo frame");
    // the echo frame carries the acknowledged screen's number: acknowledging it ends its resends
    sender.ack(sent[1]!.num);
    // fixed wait: proving that nothing is resent, over several 50 ms retransmission timeouts
    await Bun.sleep(300);
    expect(sent).toHaveLength(2);
    sender.dispose();
    screen.dispose();
  });

  it("resumes a stream from a screen the client kept", async () => {
    const screen = await Screen.create(20, 4);
    screen.write("before");
    const sent: FrameDiff[] = [];
    const first = new SyncSender(screen, { send: (diff) => { sent.push(diff); return true; }, buffered: () => 0, echo: () => 0 });
    first.schedule();
    first.ack(sent[0]!.num);
    const resume = first.resumable()!;
    first.dispose();
    screen.write(" after");
    const again: FrameDiff[] = [];
    const second = new SyncSender(screen, { send: (diff) => { again.push(diff); return true; }, buffered: () => 0, echo: () => 0 }, { stream: resume.stream, base: resume.frames.get(sent[0]!.num)! });
    second.schedule();
    expect(again[0]!.stream).toBe(resume.stream);
    expect(again[0]!.base).toBe(sent[0]!.num);
    const client = receiver();
    client.apply(sent[0]!);
    expect(frameText(client.apply(again[0]!)!)[0]).toBe("before after");
    second.dispose();
    screen.dispose();
  });
});

describe("EchoClock", () => {
  it("says an input is echoed once the program has had ECHO_DELAY_MS for it", () => {
    let now = 1000;
    const clock = new EchoClock(() => now);
    expect(clock.echo()).toBe(0);
    expect(clock.mark(1)).toBe(1000 + ECHO_DELAY_MS);
    now += 10;
    clock.mark(2);
    expect(clock.echo()).toBe(0);
    now = 1000 + ECHO_DELAY_MS;
    expect(clock.echo()).toBe(1);
    now += 10;
    expect(clock.echo()).toBe(2);
    // an older number never moves it back
    clock.mark(1);
    now += 100;
    expect(clock.echo()).toBe(2);
  });
});
