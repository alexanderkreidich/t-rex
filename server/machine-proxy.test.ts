import { afterAll, describe, expect, it } from "bun:test";

import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

// A remote bridge that records what each forwarded request carried.
const asked: { path: string; search: string; authorization: string | null; cookie: string | null; forwarded: string | null }[] = [];
const remote = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    asked.push({ path: url.pathname, search: url.search, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), forwarded: request.headers.get("x-forwarded-for") });
    return Response.json({ read: { text: "remote screen" } }, { headers: { "set-cookie": "remote=1" } });
  },
});
afterAll(() => remote.stop());

const manager = {
  endpoint: () => ({ url: `http://127.0.0.1:${remote.port}`, token: "remote-token" }),
  trackTerminal: () => () => undefined,
} as unknown as MachineManager;

describe("PC proxy", () => {
  it("forwards a read with its query and the bridge's own credential, and nothing of the browser's", async () => {
    const search = "?pane_id=w1%3Ap1&source=visible";
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/pane/read${search}`, {
      headers: { cookie: "herdr_web_token=browser-secret", authorization: "Bearer browser-secret", "x-forwarded-for": "203.0.113.7" },
    }), manager);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: { text: "remote screen" } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(asked.at(-1)).toEqual({ path: "/api/pane/read", search, authorization: "Bearer remote-token", cookie: null, forwarded: null });
  });

  it("forwards only the routes it lists, and only for this app", async () => {
    const before = asked.length;
    for (const path of ["pc1/fs/file?path=%2Fetc%2Fhostname", "pc1/pane/conversation?pane_id=w1%3Ap1", "pc1/workspace/diff/files", "pc1/pane/read/extra"]) {
      expect((await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${path}`), manager)).status).toBe(404);
    }
    const crossSite = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/pane/read?pane_id=w1%3Ap1", {
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    }), manager);
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: { code: "invalid_origin" } });
    expect(asked.length).toBe(before);
  });

  it("refuses a path with an empty segment instead of forwarding it as another route", async () => {
    const before = asked.length;
    for (const path of ["pc1//pane/read?pane_id=w1%3Ap1", "pc1/pane//read?pane_id=w1%3Ap1", "pc1//session"]) {
      expect((await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${path}`), manager)).status).toBe(404);
    }
    expect(asked.length).toBe(before);
  });
});
