import { MAX_GRAPHICS_BYTES, type GraphicsScene } from "./ssp-graphics.ts";

export const GRAPHICS_CHUNK_SIZE = 128 * 1024;
export const MAX_GRAPHICS_BASE64 = Math.ceil(MAX_GRAPHICS_BYTES / 3) * 4;
export interface GraphicsChunk { key: string; offset: number; total: number; data: string }

/** Pixels are transferred separately, so no screen frame can overflow the socket's 1 MiB cap. */
const metadata = new WeakMap<GraphicsScene, GraphicsScene>();
export function graphicsMetadata(scene?: GraphicsScene): GraphicsScene | undefined {
  if (!scene) return undefined;
  let cached = metadata.get(scene);
  if (!cached) { cached = { assets: scene.assets.map((asset) => ({ ...asset, data: "" })), placements: scene.placements }; metadata.set(scene, cached); }
  return cached;
}

/** One bounded upload in progress; completed pixels are retained only for the newest scene. */
export class GraphicsReceiver {
  private readonly pixels = new Map<string, string>();
  private needed = new Set<string>();
  private partial: { key: string; total: number; offset: number; parts: string[] } | null = null;
  private bytes = 0;

  scene(scene?: GraphicsScene): void {
    this.needed = new Set(scene?.assets.map((asset) => asset.key));
    for (const [key, data] of this.pixels) if (!this.needed.has(key)) { this.pixels.delete(key); this.bytes -= data.length; }
    if (this.partial && !this.needed.has(this.partial.key)) { this.bytes -= this.partial.offset; this.partial = null; }
  }

  accept(chunk: GraphicsChunk): number | null {
    const { key, offset, total, data } = chunk;
    if (!this.needed.has(key) || !Number.isInteger(offset) || !Number.isInteger(total) || offset < 0 || total <= 0 || total > MAX_GRAPHICS_BASE64
      || total % 4 !== 0 || offset % 4 !== 0 || data.length === 0 || data.length % 4 !== 0 || data.length > GRAPHICS_CHUNK_SIZE || offset + data.length > total
      || (offset + data.length < total && data.includes("=")) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
    const complete = this.pixels.get(key);
    if (complete) return complete.length === total ? total : null;
    if (!this.partial) {
      if (offset !== 0) return null;
      this.partial = { key, total, offset: 0, parts: [] };
    }
    const partial = this.partial;
    if (partial.key !== key || partial.total !== total) return null;
    if (offset < partial.offset) return partial.offset;
    if (offset !== partial.offset || this.bytes + data.length > MAX_GRAPHICS_BASE64) return null;
    partial.parts.push(data);
    partial.offset += data.length;
    this.bytes += data.length;
    if (partial.offset === total) {
      this.pixels.set(key, partial.parts.join(""));
      this.partial = null;
    }
    return offset + data.length;
  }

  hydrate(scene?: GraphicsScene): GraphicsScene | undefined {
    if (!scene) return scene;
    return { assets: scene.assets.flatMap((asset) => {
      const data = asset.data || this.pixels.get(asset.key);
      return data ? [{ ...asset, data }] : [];
    }), placements: scene.placements };
  }

  reset(): void { this.pixels.clear(); this.needed.clear(); this.partial = null; this.bytes = 0; }
}
