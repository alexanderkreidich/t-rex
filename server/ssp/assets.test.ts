import { expect, it } from "bun:test";
import { GRAPHICS_CHUNK_SIZE, MAX_GRAPHICS_BASE64, GraphicsReceiver, graphicsMetadata, type GraphicsChunk } from "../../shared/ssp-assets.ts";
import { EMPTY_GRAPHICS, type GraphicsScene } from "../../shared/ssp-graphics.ts";
import { GraphicsSender } from "./assets.ts";

const scene = (): GraphicsScene => ({ assets: [{ key: "image:1", format: 32, width: 1, height: 1, data: "A".repeat(GRAPHICS_CHUNK_SIZE * 3 + 4) }], placements: [] });

it("uses a two-chunk window, rejects ahead-of-send ACKs, and reconstructs after duplicate or reordered chunks", () => {
  const source = scene();
  const receiver = new GraphicsReceiver();
  receiver.scene(graphicsMetadata(source));
  const queued: GraphicsChunk[] = [];
  const sender = new GraphicsSender({ buffered: () => 0, send: (chunk) => { queued.push(chunk); return true; } });
  try {
    sender.setScene(source);
    expect(queued).toHaveLength(2);
    const first = queued.shift()!, second = queued.shift()!;
    expect(receiver.accept(second)).toBeNull();
    expect(receiver.accept(first)).toBe(GRAPHICS_CHUNK_SIZE);
    expect(receiver.accept(first)).toBe(GRAPHICS_CHUNK_SIZE);
    expect(sender.ack(first.key, GRAPHICS_CHUNK_SIZE * 10)).toBe(false);
    expect(sender.ack(first.key, GRAPHICS_CHUNK_SIZE)).toBe(true);
    expect(queued).toHaveLength(1);
    expect(receiver.accept(second)).toBe(GRAPHICS_CHUNK_SIZE * 2);
    expect(sender.ack(second.key, GRAPHICS_CHUNK_SIZE * 2)).toBe(true);
    while (queued.length) {
      const chunk = queued.shift()!;
      const ack = receiver.accept(chunk);
      expect(ack).not.toBeNull();
      expect(sender.ack(chunk.key, ack!)).toBe(true);
    }
    expect(receiver.hydrate(graphicsMetadata(source))?.assets[0]?.data).toBe(source.assets[0]!.data);
    sender.setScene(EMPTY_GRAPHICS);
    receiver.scene(EMPTY_GRAPHICS);
    expect(receiver.hydrate(EMPTY_GRAPHICS)).toEqual(EMPTY_GRAPHICS);
    expect(sender.ack(first.key, first.total)).toBe(true); // an old in-flight ACK cannot revive the asset
  } finally { sender.dispose(); }
});

it("pauses on transport backpressure, retries a bounded outstanding chunk and cancels obsolete uploads", () => {
  let buffered = 1_000_000, now = 0;
  const source = scene();
  const queued: GraphicsChunk[] = [];
  const sender = new GraphicsSender({ buffered: () => buffered, send: (chunk) => { queued.push(chunk); return true; } }, () => now);
  try {
    sender.setScene(source);
    expect(queued).toHaveLength(0);
    buffered = 0;
    sender.drain();
    expect(queued).toHaveLength(2);
    for (let i = 0; i < 20; i++) sender.drain();
    expect(queued).toHaveLength(2);
    now = 1001;
    sender.drain();
    expect(queued).toHaveLength(3);
    expect(queued[2]!.offset).toBe(0);
    for (now = 2002; now < 10_000; now += 1001) sender.drain();
    expect(queued).toHaveLength(5); // three silent retries, then no traffic into a hidden view
    sender.setScene(source); // a fresh screen ACK rearms the transfer
    expect(queued).toHaveLength(6);
    sender.setScene(EMPTY_GRAPHICS);
    now += 3000;
    sender.drain();
    expect(queued).toHaveLength(6);
  } finally { sender.dispose(); }
});

it("ignores unknown assets and rejects allocation or sequence injection outside the pixel budget", () => {
  const receiver = new GraphicsReceiver();
  receiver.scene(graphicsMetadata(scene()));
  const chunk: GraphicsChunk = { key: "image:1", offset: 0, total: 4, data: "/w==" };
  expect(receiver.accept({ ...chunk, key: "unknown" })).toBeNull();
  expect(receiver.accept({ ...chunk, total: MAX_GRAPHICS_BASE64 + 4 })).toBeNull();
  expect(receiver.accept({ ...chunk, data: "\x1b[2J" })).toBeNull();
  expect(receiver.accept({ ...chunk, offset: 4 })).toBeNull();
  expect(receiver.accept(chunk)).toBe(4);
  receiver.scene(EMPTY_GRAPHICS);
  expect(receiver.accept(chunk)).toBeNull();
  receiver.reset();
});
