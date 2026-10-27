/**
 * Draws the app's icons, favicon, Apple touch icon, notification badge and social preview: the
 * T-Rex of Chrome's offline game redrawn as pixel art, its head and chest in the app's amber
 * rising from the bottom of a dark tile. Every size is the 192 px drawing scaled: it is sampled
 * eight times per pixel and averaged, so the favicon is the same picture as the home-screen icon.
 * Needs nothing beyond Bun.
 *
 *   bun scripts/generate-brand.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const DINO = [
  "...........#########..",
  "..........##.########.",
  "..........###########.",
  "..........###########.",
  "..........###########.",
  "..........######......",
  "..........#########...",
  "#........######.......",
  "#.......#######.......",
  "##.....##########.....",
  "###...#########.#.....",
  "##############........",
  "##############........",
  ".############.........",
  "..##########..........",
  "...########...........",
  "....######............",
  ".....###.##...........",
  ".....##...#...........",
  ".....#....#...........",
  ".....##...##..........",
];
/** The icon's part of the dino: head, neck, chest and arm. */
const BUST = DINO.slice(0, 14).map((row) => row.slice(4));
/** Where the bust sits on the 192 px icon, in fractions of its side: 11 px art pixels, the head near the top, running off the left and bottom edges. */
const CELL = 11 / 192, LEFT = -14 / 192, TOP = 38 / 192;

const WORD: Record<string, string[]> = {
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "-": [".....", ".....", ".....", "####.", ".....", ".....", "....."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
};

type Rgba = [number, number, number, number];
// the app's dark panel, its accent and its strong text (src/styles.css)
const TILE: Rgba = [0x18, 0x16, 0x13, 255];
const AMBER: Rgba = [0xf0, 0xa8, 0x30, 255];
const CREAM: Rgba = [0xf2, 0xeb, 0xdf, 255];
const WHITE: Rgba = [255, 255, 255, 255];

class Canvas {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number, background: Rgba) {
    this.pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.pixels.set(background, i * 4);
  }
  rect(x: number, y: number, w: number, h: number, color: Rgba): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + w); col++) this.pixels.set(color, (row * this.width + col) * 4);
    }
  }
  art(rows: string[], x: number, y: number, scale: number, color: Rgba): void {
    rows.forEach((row, r) => [...row].forEach((cell, c) => { if (cell === "#") this.rect(x + c * scale, y + r * scale, scale, scale, color); }));
  }
}

const inArt = (rows: string[], u: number, v: number) => rows[Math.floor(v)]?.[Math.floor(u)] === "#";

/** Whether (x, y) is inside a square of side `size` whose corners are rounded by `radius`. */
function inTile(x: number, y: number, size: number, radius: number): boolean {
  const dx = Math.max(radius - x, x - (size - radius), 0);
  const dy = Math.max(radius - y, y - (size - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

interface IconOptions {
  /** null: the ink alone on transparent */
  background?: Rgba | null;
  ink?: Rgba;
  /** the corner radius, a fraction of the side; 0 for a square the platform masks itself */
  corner?: number;
}

function icon(size: number, { background = TILE, ink = AMBER, corner = 0.22 }: IconOptions = {}): Canvas {
  const canvas = new Canvas(size, size, [0, 0, 0, 0]);
  const cell = CELL * size, left = LEFT * size, top = TOP * size;
  const radius = corner * size;
  const k = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0, inked = 0;
      for (let sy = 0; sy < k; sy++) {
        for (let sx = 0; sx < k; sx++) {
          const px = x + (sx + 0.5) / k, py = y + (sy + 0.5) / k;
          if (!inTile(px, py, size, radius)) continue;
          tile++;
          if (inArt(BUST, (px - left) / cell, (py - top) / cell)) inked++;
        }
      }
      const samples = k * k;
      let color: Rgba;
      if (background === null) color = [ink[0], ink[1], ink[2], Math.round((255 * inked) / samples)];
      else if (tile === 0) color = [0, 0, 0, 0];
      else {
        const mix = (channel: 0 | 1 | 2) => Math.round((background[channel] * (tile - inked) + ink[channel] * inked) / tile);
        color = [mix(0), mix(1), mix(2), Math.round((255 * tile) / samples)];
      }
      canvas.pixels.set(color, (y * size + x) * 4);
    }
  }
  return canvas;
}

/** The bust rising from the bottom left, the word to its right with a cursor after it. */
function socialPreview(): Canvas {
  const canvas = new Canvas(1280, 640, TILE);
  const dino = 30, letter = 14;
  canvas.art(BUST, 110, 640 - (BUST.length - 1) * dino, dino, AMBER);
  const word = ["T", "-", "R", "e", "x"];
  const left = 740, top = 300;
  word.forEach((glyph, i) => canvas.art(WORD[glyph]!, left + i * 6 * letter, top, letter, CREAM));
  canvas.rect(left + word.length * 6 * letter, top + 2 * letter, 3 * letter, 5 * letter, AMBER);
  return canvas;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(canvas: Canvas): Buffer {
  const { width, height, pixels } = canvas;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())]);
}
/** An .ico holding one PNG, which every browser that asks for /favicon.ico reads. */
function ico(canvas: Canvas): Buffer {
  const image = png(canvas);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  header[6] = canvas.width % 256;
  header[7] = canvas.height % 256;
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, image]);
}

const root = join(import.meta.dir, "..");
const out = (path: string, bytes: Buffer) => { writeFileSync(join(root, path), bytes); console.log(path); };

out("public/icons/icon-192.png", png(icon(192)));
out("public/icons/icon-512.png", png(icon(512)));
// maskable: square, the platform masks it (Chrome on macOS takes it for the Dock); the same drawing,
// so the Dock shows the bust as large as the plain icon. A circle mask trims the tip of the snout.
out("public/icons/icon-maskable-192.png", png(icon(192, { corner: 0 })));
out("public/icons/icon-maskable-512.png", png(icon(512, { corner: 0 })));
// Android draws a notification's small icon from its alpha alone: the bust white on transparent
out("public/icons/badge-96.png", png(icon(96, { background: null, ink: WHITE, corner: 0 })));
// iOS rounds the home-screen icon itself and fills transparent corners with black
out("public/apple-touch-icon.png", png(icon(180, { corner: 0 })));
out("public/favicon.png", png(icon(64)));
out("public/favicon.ico", ico(icon(32)));
out("public/social-preview.png", png(socialPreview()));
