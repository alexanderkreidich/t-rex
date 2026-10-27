/**
 * Builds T-Rex for the Mac into macos/build/T-Rex.app (docs/macos.md): the Swift window
 * (macos/, `swift build`), the page's side of it (macos/Resources), the icon, and the bridge it
 * starts when none runs for this herdr: the remote PC bundle for this Mac
 * (scripts/build-remote-bundle.ts: Bun, Node and node-pty pinned by checksum, server/, shared/,
 * dist/ and the production node_modules), unpacked. Run `bun run build` first; the bundle carries
 * that client. Signed ad hoc.
 *
 *   bun run build:mac
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const macos = join(root, "macos");
const platform = `${process.platform}-${process.arch}`;
if (process.platform !== "darwin") throw new Error(`The Mac app builds on macOS only, not ${platform}`);
if (!existsSync(join(root, "dist/index.html"))) throw new Error("Run bun run build first: the app's bridge serves that client");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const app = join(macos, "build", "T-Rex.app");
const contents = join(app, "Contents");

function run(argv: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`${argv.join(" ")} failed (${result.status ?? result.signal})`);
  return result.stdout;
}

console.log("swift build");
run(["swift", "build", "-c", "release", "--package-path", macos], root);
const binary = join(run(["swift", "build", "-c", "release", "--package-path", macos, "--show-bin-path"]).trim(), "TRex");

rmSync(app, { recursive: true, force: true });
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(contents, "Resources"), { recursive: true });
cpSync(binary, join(contents, "MacOS", "T-Rex"));
for (const file of ["app.css", "app.js"]) cpSync(join(macos, "Resources", file), join(contents, "Resources", file));
writeFileSync(join(contents, "Info.plist"), infoPlist());
writeFileSync(join(contents, "PkgInfo"), "APPL????");

const work = mkdtempSync(join(tmpdir(), "t-rex-mac-"));
try {
  // the icon: the PWA's square drawing (scripts/generate-brand.ts) inset on Apple's 1024 grid, which
  // macOS shows as it is: a Mac icon carries its own shape and margin
  const iconset = join(work, "T-Rex.iconset");
  mkdirSync(iconset);
  const tile = join(work, "tile.png");
  run(["sips", "-z", "824", "824", join(root, "public/icons/icon-512.png"), "--out", tile]);
  const master = join(work, "master.png");
  run(["sips", "-p", "1024", "1024", tile, "--out", master]);
  for (const size of [16, 32, 128, 256, 512]) {
    run(["sips", "-z", String(size), String(size), master, "--out", join(iconset, `icon_${size}x${size}.png`)]);
    run(["sips", "-z", String(size * 2), String(size * 2), master, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run(["iconutil", "-c", "icns", iconset, "-o", join(contents, "Resources", "T-Rex.icns")]);

  console.log(`bridge for ${platform}`);
  run([process.execPath, "scripts/build-remote-bundle.ts", platform], root, { ...process.env, HERDR_BUNDLE_OUTPUT: work });
  const bridge = join(contents, "Resources", "bridge");
  mkdirSync(bridge);
  run(["tar", "xzf", join(work, `t-rex-${platform}.tgz`), "-C", bridge]);
  // node_modules keeps what the bridge runs: the client's packages are in dist/ already, and its
  // build tools are for a checkout. The bundle's own herdr goes too: the app runs the Mac's
  // (macos/Sources/TRex/Bridge.swift)
  const modules = join(bridge, "node_modules");
  const kept = runtimePackages(modules);
  for (const name of packagesIn(modules)) if (!kept.has(name)) rmSync(join(modules, name), { recursive: true, force: true });
  for (const scope of readdirSync(modules)) if (scope.startsWith("@") && readdirSync(join(modules, scope)).length === 0) rmSync(join(modules, scope), { recursive: true });
  for (const dir of ["playground", "src", "tests", "docs", "examples", "assets"]) rmSync(join(modules, "restty", dir), { recursive: true, force: true });
  rmSync(join(modules, ".bin"), { recursive: true, force: true });
  rmSync(join(bridge, "bin", "herdr"), { force: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("codesign (ad hoc)");
run(["codesign", "--force", "--deep", "--sign", "-", "--identifier", "com.alexanderkreidich.t-rex", app]);
console.log(`${app} (${run(["du", "-sh", app]).split("\t")[0]})`);

/** Every package in node_modules, scoped ones as `@scope/name`. */
function packagesIn(modules: string): string[] {
  return readdirSync(modules).filter((name) => !name.startsWith(".")).flatMap((name) =>
    name.startsWith("@") ? readdirSync(join(modules, name)).map((inner) => `${name}/${inner}`) : [name]);
}

/** package.json's dependencies the server imports, and everything they depend on that is installed. */
function runtimePackages(modules: string): Set<string> {
  const CLIENT_ONLY = new Set(["react", "react-dom", "lucide-react", "qrcode-generator"]);
  const manifest = (name: string) => JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const queue = Object.keys(own.dependencies).filter((name) => !CLIENT_ONLY.has(name));
  const kept = new Set<string>();
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (kept.has(name) || !existsSync(join(modules, name, "package.json"))) continue;
    kept.add(name);
    const { dependencies = {}, optionalDependencies = {} } = manifest(name);
    queue.push(...Object.keys(dependencies), ...Object.keys(optionalDependencies));
  }
  return kept;
}

function infoPlist(): string {
  const entries: Record<string, string | boolean> = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: "T-Rex",
    CFBundleExecutable: "T-Rex",
    CFBundleIconFile: "T-Rex",
    CFBundleIdentifier: "com.alexanderkreidich.t-rex",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "T-Rex",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSApplicationCategoryType: "public.app-category.developer-tools",
    LSMinimumSystemVersion: "15.0",
    NSHighResolutionCapable: true,
    NSHumanReadableCopyright: "Copyright © 2026 Alexander Kreidich",
    NSSupportsAutomaticGraphicsSwitching: true,
  };
  const body = Object.entries(entries).map(([key, value]) =>
    `  <key>${key}</key>\n  ${typeof value === "boolean" ? `<${value}/>` : `<string>${value}</string>`}`).join("\n");
  // the bridge is plain http on loopback, which App Transport Security refuses unless told
  const ats = "  <key>NSAppTransportSecurity</key>\n  <dict>\n    <key>NSAllowsLocalNetworking</key>\n    <true/>\n  </dict>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
${ats}
</dict>
</plist>
`;
}
