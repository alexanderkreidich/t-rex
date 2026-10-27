import { GRAPHICS_CHUNK_SIZE, type GraphicsChunk } from "../../shared/ssp-assets.ts";
import { EMPTY_GRAPHICS, type GraphicsAsset, type GraphicsScene } from "../../shared/ssp-graphics.ts";

const WINDOW = 2;
const RETRY_MS = 1000;
const BUFFERED_LIMIT = 256 * 1024;
interface Upload {
  asset: GraphicsAsset;
  next: number;
  acked: number;
  retries: number;
  sent: { offset: number; end: number; at: number }[];
}

/** A tiny acknowledged pixel window, independent of screen pacing and terminal input. */
export class GraphicsSender {
  private scene: GraphicsScene = EMPTY_GRAPHICS;
  private readonly done = new Set<string>();
  private upload: Upload | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly target: { send(chunk: GraphicsChunk): boolean; buffered(): number }, private readonly now = Date.now) {}

  setScene(scene: GraphicsScene = EMPTY_GRAPHICS): void {
    // A screen ACK proves the pane is being consumed again (a hidden view may stop ACKing).
    if (this.upload) this.upload.retries = 0;
    if (scene === this.scene) { this.pump(); return; }
    this.scene = scene;
    const needed = new Set(scene.assets.map((asset) => asset.key));
    for (const key of this.done) if (!needed.has(key)) this.done.delete(key);
    if (this.upload && !needed.has(this.upload.asset.key)) this.upload = null;
    this.pump();
  }

  ack(key: string, offset: number): boolean {
    if (!Number.isInteger(offset) || offset < 0) return false;
    if (this.done.has(key) || !this.scene.assets.some((asset) => asset.key === key)) return true;
    const upload = this.upload;
    if (!upload || upload.asset.key !== key) return false;
    if (offset <= upload.acked) return true;
    if (!upload.sent.some((chunk) => chunk.end === offset)) return false;
    upload.acked = offset;
    upload.retries = 0;
    upload.sent = upload.sent.filter((chunk) => chunk.end > offset);
    if (offset === upload.asset.data.length) { this.done.add(key); this.upload = null; }
    this.pump();
    return true;
  }

  private send(upload: Upload, offset: number): boolean {
    return this.target.send({ key: upload.asset.key, offset, total: upload.asset.data.length, data: upload.asset.data.slice(offset, offset + GRAPHICS_CHUNK_SIZE) });
  }

  private pump(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    if (!this.upload) {
      const asset = this.scene.assets.find((asset) => !this.done.has(asset.key) && asset.data.length > 0);
      if (asset) this.upload = { asset, next: 0, acked: 0, retries: 0, sent: [] };
    }
    const upload = this.upload;
    if (!upload) return;
    const now = this.now();
    if (this.target.buffered() <= BUFFERED_LIMIT) {
      const oldest = upload.sent[0];
      if (oldest && now - oldest.at >= RETRY_MS) {
        if (upload.retries >= 3) return; // wait for a screen/asset ACK instead of streaming into a hidden tab
        if (this.send(upload, oldest.offset)) { oldest.at = now; upload.retries++; }
      }
      while (upload.sent.length < WINDOW && upload.next < upload.asset.data.length && this.target.buffered() <= BUFFERED_LIMIT) {
        if (!this.send(upload, upload.next)) break;
        const end = Math.min(upload.asset.data.length, upload.next + GRAPHICS_CHUNK_SIZE);
        upload.sent.push({ offset: upload.next, end, at: now });
        upload.next = end;
      }
    }
    const retry = upload.sent[0] ? Math.max(50, upload.sent[0].at + RETRY_MS - this.now()) : 50;
    this.timer = setTimeout(() => this.pump(), retry);
  }

  drain(): void { this.pump(); }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.upload = null;
    this.done.clear();
    this.scene = EMPTY_GRAPHICS;
  }
}
