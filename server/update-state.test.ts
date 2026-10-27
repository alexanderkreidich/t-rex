import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDirFor } from "./update-state.ts";

let config: string;
beforeEach(() => { config = mkdtempSync(join(tmpdir(), "t-rex-state-")); });
afterEach(() => { rmSync(config, { recursive: true, force: true }); });

it("keeps the state of the app's old name while that dir is there, and t-rex otherwise", () => {
  expect(stateDirFor({ XDG_CONFIG_HOME: config })).toBe(join(config, "t-rex"));
  mkdirSync(join(config, "t-rex", "bridges"), { recursive: true });
  mkdirSync(join(config, "herdr-web-ui"));
  // a bridge registry under the new name is no reason to leave the devices and push keys behind
  expect(stateDirFor({ XDG_CONFIG_HOME: config })).toBe(join(config, "herdr-web-ui"));
  expect(stateDirFor({ XDG_CONFIG_HOME: config, HERDR_WEB_STATE_DIR: "/elsewhere" })).toBe("/elsewhere");
});
