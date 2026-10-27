import { expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

it("does not ship a usage collector or its browser controls", () => {
  for (const path of ["server/telemetry.ts", "shared/telemetry.ts", "src/components/TelemetryControls.tsx", "telemetry"]) {
    expect(existsSync(resolve(root, path))).toBe(false);
  }
});

it("does not collect visits or settings for usage reporting", () => {
  for (const path of ["server/index.ts", "server/core/status.ts", "server/core/socket.ts", "src/App.tsx", "src/components/SettingsDialog.tsx", "src/lib/api.ts", "src/lib/settings.ts"]) {
    const source = readFileSync(resolve(root, path), "utf8");
    expect(source).not.toContain("Telemetry");
    expect(source).not.toContain("telemetrySettingsSnapshot");
    expect(source).not.toContain("/api/telemetry");
    expect(source).not.toContain("countVisit");
  }
});
