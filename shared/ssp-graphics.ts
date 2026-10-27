/** Bounded visible image state, not a journal of Kitty APC commands. */
export interface GraphicsAsset {
  readonly key: string;
  readonly format: 24 | 32 | 100;
  readonly width: number;
  readonly height: number;
  readonly data: string;
}

export interface GraphicsPlacement {
  readonly asset: string;
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
  readonly z: number;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface GraphicsScene {
  readonly assets: readonly GraphicsAsset[];
  readonly placements: readonly GraphicsPlacement[];
}

export const EMPTY_GRAPHICS: GraphicsScene = { assets: [], placements: [] };
export const MAX_GRAPHICS_BYTES = 16 * 1024 * 1024;
export const MAX_GRAPHICS_PLACEMENTS = 1024;

/** Full placements, but only pixels absent from the acknowledged/base scene. */
export function graphicsDiff(base: GraphicsScene = EMPTY_GRAPHICS, next: GraphicsScene = EMPTY_GRAPHICS): GraphicsScene | undefined {
  if (base === next || (base.assets.map((asset) => asset.key).join("|") === next.assets.map((asset) => asset.key).join("|")
    && JSON.stringify(base.placements) === JSON.stringify(next.placements))) return undefined;
  const known = new Set(base.assets.map((asset) => asset.key));
  return { assets: next.assets.filter((asset) => !known.has(asset.key)), placements: next.placements };
}

export function applyGraphics(base: GraphicsScene = EMPTY_GRAPHICS, delta?: GraphicsScene): GraphicsScene {
  if (!delta) return base;
  const needed = new Set(delta.placements.map((placement) => placement.asset));
  const assets = new Map(base.assets.filter((asset) => needed.has(asset.key)).map((asset) => [asset.key, asset]));
  for (const asset of delta.assets) if (needed.has(asset.key)) assets.set(asset.key, asset);
  return { assets: [...assets.values()], placements: delta.placements };
}

/** CUP clamps out-of-grid coordinates; clip images first so a pending resize cannot move them. */
export function fitGraphics(scene: GraphicsScene = EMPTY_GRAPHICS, cols: number, rows: number): GraphicsScene {
  if (scene.placements.every((p) => p.col >= 0 && p.row >= 0 && p.col + p.cols <= cols && p.row + p.rows <= rows)) return scene;
  const assets = new Map(scene.assets.map((asset) => [asset.key, asset]));
  const placements: GraphicsPlacement[] = [];
  for (const p of scene.placements) {
    const asset = assets.get(p.asset);
    if (!asset || p.cols <= 0 || p.rows <= 0) continue;
    const left = Math.max(0, -p.col), top = Math.max(0, -p.row);
    const width = Math.min(p.cols - left, cols - Math.max(0, p.col));
    const height = Math.min(p.rows - top, rows - Math.max(0, p.row));
    if (width <= 0 || height <= 0) continue;
    const sourceWidth = p.sourceWidth || asset.width, sourceHeight = p.sourceHeight || asset.height;
    placements.push({ ...p, col: Math.max(0, p.col), row: Math.max(0, p.row), cols: width, rows: height,
      sourceX: p.sourceX + Math.floor(sourceWidth * left / p.cols), sourceY: p.sourceY + Math.floor(sourceHeight * top / p.rows),
      sourceWidth: Math.max(1, Math.floor(sourceWidth * width / p.cols)), sourceHeight: Math.max(1, Math.floor(sourceHeight * height / p.rows)),
      offsetX: left ? 0 : p.offsetX, offsetY: top ? 0 : p.offsetY,
    });
  }
  const used = new Set(placements.map((p) => p.asset));
  return { assets: scene.assets.filter((asset) => used.has(asset.key)), placements };
}

const APC = "\x1b_G";
const END = "\x1b\\";
const uint = (value: number): number => Number.isFinite(value) ? Math.min(0xffff_ffff, Math.max(0, Math.trunc(value))) : 0;
const signed = (value: number): number => Number.isFinite(value) ? Math.min(0x7fff_ffff, Math.max(-0x8000_0000, Math.trunc(value))) : 0;

/** Renderer-local reconciliation. Image IDs never escape this display or depend on remote IDs. */
export class GraphicsDisplay {
  private readonly images = new Map<string, number>();
  private nextId = 10_000;
  private previous = "";

  draw(scene: GraphicsScene = EMPTY_GRAPHICS, reset = false, reposition = false): string {
    let out = "";
    if (reset) {
      if (this.images.size || scene.assets.length) out += `${APC}a=d,d=A,q=2${END}`;
      this.images.clear();
      this.previous = "";
    }
    const valid = scene.assets.filter((asset) => this.images.has(asset.key) || ([24, 32, 100].includes(asset.format) && asset.data.length <= MAX_GRAPHICS_BYTES * 4 / 3 + 4
      && uint(asset.width) > 0 && uint(asset.height) > 0 && uint(asset.width) * uint(asset.height) * (asset.format === 24 ? 3 : 4) <= MAX_GRAPHICS_BYTES
      && /^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)));
    const alive = new Set(valid.map((asset) => asset.key));
    for (const [key, id] of this.images) if (!alive.has(key)) {
      out += `${APC}a=d,d=I,i=${id},q=2${END}`;
      this.images.delete(key);
    }
    for (const asset of valid) {
      if (this.images.has(asset.key)) continue;
      const id = this.nextId++;
      this.images.set(asset.key, id);
      for (let offset = 0; offset < asset.data.length; offset += 4096) {
        const more = offset + 4096 < asset.data.length ? 1 : 0;
        const control = offset === 0 ? `a=t,t=d,f=${asset.format},s=${uint(asset.width)},v=${uint(asset.height)},i=${id},q=2,m=${more}` : `q=2,m=${more}`;
        out += `${APC}${control};${asset.data.slice(offset, offset + 4096)}${END}`;
      }
    }
    const placements = scene.placements.slice(0, MAX_GRAPHICS_PLACEMENTS);
    const signature = JSON.stringify(placements);
    if (signature !== this.previous || out || reposition) {
      // Lower-case a deletes placements, retaining the pixels used again below.
      if (this.images.size || placements.length || (this.previous !== "" && this.previous !== "[]")) out += `${APC}a=d,d=a,q=2${END}`;
      for (let index = 0; index < placements.length; index++) {
        const placement = placements[index]!;
        const id = this.images.get(placement.asset);
        if (id === undefined) continue;
        out += `\x1b[${uint(placement.row) + 1};${uint(placement.col) + 1}H`;
        out += `${APC}a=p,i=${id},p=${index + 1},q=2,C=1,c=${uint(placement.cols)},r=${uint(placement.rows)},z=${signed(placement.z)}`
          + `,x=${uint(placement.sourceX)},y=${uint(placement.sourceY)},w=${uint(placement.sourceWidth)},h=${uint(placement.sourceHeight)}`
          + `,X=${uint(placement.offsetX)},Y=${uint(placement.offsetY)}${END}`;
      }
      this.previous = signature;
    }
    return out;
  }
}
