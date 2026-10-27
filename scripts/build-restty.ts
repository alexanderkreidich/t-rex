// restty comes from our fork (github:alexanderkreidich/restty), and a git dependency arrives as
// source: its package.json points at dist/, which only `bun run build` in the fork writes. This
// builds that dist/ inside node_modules/restty after every `bun install` (package.json
// `postinstall`), the same way the fork's own build does: bun bundles the entry points and tsc
// writes the declarations. Both take well under a second.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pkg = join(root, "node_modules", "restty");
if (!existsSync(join(pkg, "scripts", "build-lib.ts"))) {
  // An npm release ships dist/ already and no build scripts.
  process.exit(0);
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: pkg, stdout: "ignore", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`restty build failed: ${cmd.join(" ")}`);
    process.exit(result.exitCode ?? 1);
  }
}

run([process.execPath, "scripts/build-lib.ts"]);
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
// Declarations only matter to `bun run typecheck`; a production install may lack typescript.
if (existsSync(tsc)) run([process.execPath, tsc, "-p", "tsconfig.build.json", "--rootDir", "src"]);
