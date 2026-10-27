import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalSetTheme } from "./client.ts";

let directory = "";
let listener: ReturnType<typeof Bun.listen> | undefined;
const previousSocket = process.env["HERDR_SOCKET"];
afterEach(() => {
  listener?.stop(true);
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previousSocket;
});

function standIn(supported: boolean, beforeReply = () => {}): string[] {
  directory = mkdtempSync(join(tmpdir(), "terminal-theme-rpc-"));
  const socket = join(directory, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  const methods: string[] = [];
  listener = Bun.listen({ unix: socket, socket: {
    data(peer, data) {
      const request = JSON.parse(data.toString());
      methods.push(request.method);
      beforeReply();
      peer.write(JSON.stringify({ id: request.id, result: request.method === "ping"
        ? { capabilities: { terminal_theme: supported } } : { type: "ok" } }) + "\n");
    },
  } });
  return methods;
}

it("uses the advertised theme API and leaves older Herdr untouched", async () => {
  const methods = standIn(false);
  await terminalSetTheme("term_1", null, () => true);
  expect(methods).toEqual(["ping"]);
});

it("publishes through the API, never a pane input method", async () => {
  const methods = standIn(true);
  await terminalSetTheme("term_1", null, () => true);
  expect(methods).toEqual(["ping", "terminal.theme.set"]);
});

it("does not publish after the browser loses ownership during capability discovery", async () => {
  let current = true;
  const methods = standIn(true, () => { current = false; });
  await terminalSetTheme("term_1", null, () => current);
  expect(methods).toEqual(["ping"]);
});
