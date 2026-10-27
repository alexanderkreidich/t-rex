/**
 * One restty session for the page: the WASM core, the GPU device and the parsed fonts are made
 * once and shared by every terminal, so a pane opened after the first draws without loading
 * anything. `warmTerminal` starts all three while the app is still finding its first pane.
 */
import { createResttyRuntimeSession, type ResttyRuntimeSession } from "restty/internal/runtime";
import { bundledFonts } from "./fonts.ts";

let session: ResttyRuntimeSession | null = null;

export function resttySession(): ResttyRuntimeSession {
  session ??= createResttyRuntimeSession();
  return session;
}

let warmed = false;

/** Starts loading what the first terminal waits for: the WASM core, the bundled fonts and the GPU device. */
export function warmTerminal(): void {
  if (warmed || typeof document === "undefined") return;
  warmed = true;
  const shared = resttySession();
  void shared.getWasm().catch(() => undefined);
  void bundledFonts();
  // the device is the session's; the canvas only lends it a context to pick the format with
  if (typeof navigator !== "undefined" && "gpu" in navigator) void shared.getWebGPUCore(document.createElement("canvas")).catch(() => null);
}
