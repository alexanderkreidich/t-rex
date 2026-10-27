import { expect, it } from "bun:test";
import { createHeadlessTerminal } from "restty/headless";
import { applyDiff, diffFrames, PLAIN_STYLE, type Style } from "../../shared/ssp.ts";
import { TerminalDisplay } from "../../shared/ssp-display.ts";
import { Screen } from "./screen.ts";
import { SspView } from "../../src/lib/ssp/view.ts";
import { fitGraphics } from "../../shared/ssp-graphics.ts";

const IMAGE = "\x1b_Ga=T,f=32,t=d,i=7,p=3,s=1,v=1,c=2,r=2,q=2;/wAA/w==\x1b\\";
const GREEN = IMAGE.replace("/wAA/w==", "AP8A/w==");

it("captures immutable image assets and reconstructs late-join, delta and removal scenes", async () => {
  const screen = await Screen.create(20, 10);
  const viewer = await createHeadlessTerminal({ cols: 20, rows: 10, pixelWidth: 160, pixelHeight: 160, replay: false });
  const display = new TerminalDisplay();
  const styles = new Map<number, Style>([[0, PLAIN_STYLE]]);
  const diff = (base: ReturnType<Screen["frame"]> | null) => diffFrames("graphics", base, screen.frame(), 0, 0, (id) => screen.styleOf(id));
  try {
    screen.write(IMAGE);
    const initial = screen.frame();
    expect(initial.graphics?.assets).toHaveLength(1);
    expect(initial.graphics?.placements).toHaveLength(1);
    const join = diff(null);
    expect(join.graphics?.assets).toHaveLength(1);
    const joined = applyDiff(null, join, styles);
    viewer.write(display.draw(joined, (id) => styles.get(id) ?? PLAIN_STYLE));
    expect(viewer.getKittyPlacements()).toHaveLength(1);

    screen.write("\x1b[5;1Htext");
    const changed = diff(initial);
    expect(changed.graphics?.assets ?? []).toHaveLength(0);
    const next = applyDiff(joined, changed, styles);
    viewer.write(display.draw(next, (id) => styles.get(id) ?? PLAIN_STYLE));
    expect(viewer.getKittyPlacements()).toHaveLength(1);

    screen.write("\x1b_Ga=d,d=A\x1b\\");
    const deleted = applyDiff(next, diff(next), styles);
    viewer.write(display.draw(deleted, (id) => styles.get(id) ?? PLAIN_STYLE));
    expect(viewer.getKittyPlacements()).toHaveLength(0);
    expect(initial.graphics?.assets[0]?.data).toBe("/wAA/w==");
    expect(initial.graphics?.placements).toHaveLength(1);
  } finally { viewer.dispose(); screen.dispose(); }
});

it("versions replaced pixels under the same image ID and ignores a late older frame", async () => {
  const screen = await Screen.create(20, 10);
  const viewer = await createHeadlessTerminal({ cols: 20, rows: 10, pixelWidth: 160, pixelHeight: 160, replay: false });
  const view = new SspView({ write: (data) => viewer.write(data), ack: () => {}, predictions: "never" });
  view.setSize(20, 10);
  try {
    screen.write(IMAGE);
    const red = screen.frame();
    const first = diffFrames("image", null, red, 0, 0, (id) => screen.styleOf(id));
    view.receive(first);
    screen.write(GREEN);
    const green = screen.frame();
    expect(green.graphics!.assets[0]!.key).not.toBe(red.graphics!.assets[0]!.key);
    view.receive(diffFrames("image", red, green, 0, 0, (id) => screen.styleOf(id)));
    view.receive(first);
    const placement = viewer.getKittyPlacements()[0]!;
    const data = new Uint8Array(viewer.wasm.exports.memory.buffer, placement.imageDataPtr, 4);
    expect([...data]).toEqual([0, 255, 0, 255]);
    expect(red.graphics!.assets[0]!.data).toBe("/wAA/w==");
    // A new stream can reuse IDs/revisions; it must still rebuild the renderer's pixels.
    const sameKey = { ...red, graphics: { assets: [{ ...red.graphics!.assets[0]!, key: green.graphics!.assets[0]!.key }],
      placements: red.graphics!.placements.map((p) => ({ ...p, asset: green.graphics!.assets[0]!.key })) } };
    view.receive(diffFrames("another-pane", null, sameKey, 0, 0, (id) => screen.styleOf(id)));
    const restarted = viewer.getKittyPlacements()[0]!;
    expect([...new Uint8Array(viewer.wasm.exports.memory.buffer, restarted.imageDataPtr, 4)]).toEqual([255, 0, 0, 255]);
  } finally { view.dispose(); viewer.dispose(); screen.dispose(); }
});

it("clips an out-of-grid image during resize instead of clamping its CUP onto a different cell", async () => {
  const screen = await Screen.create(20, 10);
  try {
    screen.write(IMAGE);
    const scene = screen.frame().graphics!;
    expect(fitGraphics({ ...scene, placements: scene.placements.map((p) => ({ ...p, col: 15 })) }, 10, 10).placements).toHaveLength(0);
    const clipped = fitGraphics({ ...scene, placements: scene.placements.map((p) => ({ ...p, col: -1, cols: 2, sourceWidth: 20 })) }, 10, 10);
    expect(clipped.placements[0]).toMatchObject({ col: 0, cols: 1, sourceX: 10, sourceWidth: 10 });
  } finally { screen.dispose(); }
});
