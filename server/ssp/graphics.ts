import { createHash } from "node:crypto";
import type { ResttyHeadlessTerminal } from "restty/headless";
import { EMPTY_GRAPHICS, MAX_GRAPHICS_BYTES, MAX_GRAPHICS_PLACEMENTS, graphicsDiff, type GraphicsAsset, type GraphicsScene } from "../../shared/ssp-graphics.ts";

// A logical cell size, also used for the attach client's pixel-geometry replies. Graphics
// arriving from herdr are already clipped into explicit cell-grid placements.
export const GRAPHICS_CELL_WIDTH = 8;
export const GRAPHICS_CELL_HEIGHT = 16;

export class GraphicsSnapshot {
  private previous: GraphicsScene = EMPTY_GRAPHICS;

  read(term: ResttyHeadlessTerminal): GraphicsScene {
    const known = new Map(this.previous.assets.map((asset) => [asset.key, asset]));
    const assets = new Map<string, GraphicsAsset>();
    const placements: GraphicsScene["placements"][number][] = [];
    let bytes = 0;
    for (const placement of term.getKittyPlacements().slice(0, MAX_GRAPHICS_PLACEMENTS)) {
      const { imageDataPtr: ptr, imageDataLen: length, imageWidth: width, imageHeight: height } = placement;
      if (![1, 2, 3, 4, 100].includes(placement.imageFormat) || !ptr || !length || length > MAX_GRAPHICS_BYTES || ptr + length > term.wasm.exports.memory.buffer.byteLength) continue;
      const raw = new Uint8Array(term.wasm.exports.memory.buffer, ptr, length);
      const format = placement.imageFormat === 3 ? 24 : placement.imageFormat === 100 ? 100 : 32;
      const revision = placement.imageRevision ?? createHash("sha256").update(raw).digest("hex");
      const key = `${placement.imageId}:${revision}:${format}:${width}:${height}`;
      if (!assets.has(key)) {
        const decodedLength = placement.imageFormat <= 2 ? width * height * 4 : length;
        const weight = Math.max(decodedLength, width * height * (format === 24 ? 3 : 4));
        if (bytes + weight > MAX_GRAPHICS_BYTES) continue;
        bytes += weight;
        let asset = known.get(key);
        if (!asset) {
          let pixels = raw;
          if (placement.imageFormat <= 2) {
            pixels = new Uint8Array(decodedLength);
            const stride = placement.imageFormat;
            for (let pixel = 0; pixel < width * height; pixel++) {
              pixels.set([raw[pixel * stride]!, raw[pixel * stride]!, raw[pixel * stride]!, stride === 2 ? raw[pixel * stride + 1]! : 255], pixel * 4);
            }
          }
          asset = { key, format, width, height, data: Buffer.from(pixels).toString("base64") };
        }
        assets.set(key, asset);
      }
      placements.push({ asset: key, col: placement.x, row: placement.y, z: placement.z,
        cols: Math.max(1, Math.ceil(placement.width / GRAPHICS_CELL_WIDTH)), rows: Math.max(1, Math.ceil(placement.height / GRAPHICS_CELL_HEIGHT)),
        sourceX: placement.sourceX, sourceY: placement.sourceY, sourceWidth: placement.sourceWidth, sourceHeight: placement.sourceHeight,
        offsetX: placement.cellOffsetX, offsetY: placement.cellOffsetY,
      });
    }
    const scene: GraphicsScene = { assets: [...assets.values()], placements };
    if (graphicsDiff(this.previous, scene)) this.previous = scene;
    return this.previous;
  }
}
