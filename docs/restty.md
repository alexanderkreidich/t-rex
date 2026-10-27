# Restty terminal integration

The browser uses the native runtime from `alexanderkreidich/restty`, pinned to `73cc447a7daac3819e33eccb96aa4c3b760ed9f5`.
`bun install` builds that git dependency through `scripts/build-restty.ts`; no xterm.js
packages, source patches or build step remain. This does not change ownership of the PTY:
herdr remains authoritative, including history, selection ranges and keyboard protocol.

## Rendering and Appearance

- Settings -> Appearance -> Terminal controls font, size, ligatures, Ghostty theme and renderer
  (`auto`, `webgpu`, `webgl2`). JetBrains Mono is the default, with bundled regular, bold,
  italic and bold-italic TTF faces and Symbols Nerd Font. Unicode/emoji/CJK fallbacks load lazily.
- Runtime/font initialization is warmed at page startup and shared across panes. TTF avoids
  the WOFF2 JavaScript decoder on the terminal's critical path (about 56 ms in the initial probe).
- SSP frames paint the same native runtime as raw/watch and read-only mirrored output.
  Program modes enter restty through its PTY connection, not just a renderer write; restty's
  device replies do not bypass the bridge's authoritative query handling.
- The active grid owner's RGB defaults and 16 ANSI colours travel with attach/resize. On a Herdr
  advertising `terminal_theme`, the bridge publishes them through `terminal.theme.set`, so Pi's
  `system` theme can query the actual palette and refresh on changes. Observers do not publish;
  releasing the grid restores the next operator's palette, and detaching restores Herdr's inherited
  host colours. Older Herdr keeps its existing behaviour without receiving an unknown method or
  terminal replies as typing.
- The app owns resize/fit, wheel/history navigation, drag/word selection, copy, safe HTTP(S)/OSC 8
  links, search overlays, touch/pinch and input routing. Herdr supplies authoritative selection
  text; a synchronous visible-screen fallback preserves the clipboard gesture.
- Native and replacement IME adapters preserve corrected DOM commits, punctuation order and
  cancellation on pane reset. See [terminal input](terminal-input.md) for limits of replay QA.

Sandbox screenshots: [desktop dark](screenshots/restty/desktop-dark.png),
[phone dark](screenshots/restty/phone-dark.png), [desktop light](screenshots/restty/desktop-light.png).

## Text sharpness

The pinned renderer preserves glyph bitmap dimensions when the shaped advance differs from
the cell width only because of pixel rounding (for example, 8.4 px rounded to an 8 px cell).
Both WebGPU and WebGL2 compare the rounded advance before fitting a glyph, avoiding a second
bitmap resampling pass that blurred small text at DPR 1. Genuinely oversized glyphs still fit.
The dependency carries ten backend regression cases; browser checks cover Latin/Cyrillic
regular, bold and italic text at DPR 1 and 2.

## New-tab critical path

Agentless `POST /api/tab/create` replies include herdr's actual tab/pane objects. Older bridges
can omit them and keep the previous refresh path. The browser can therefore mount a new
terminal without waiting for `/api/session` and its agent-process discovery.

`CreatedTabs` temporarily merges creation replies into stale HTTP/SSE rosters, until a roster
acknowledges them. Without that guard a stale cache removed the new pane, detached it, then
reattached after another session read. Pane exit cancels the pending entry; an unacknowledged
entry expires after 10 seconds. Unit tests cover stale rosters, acknowledgement, concurrent
creation, exit, expiry and old bridges. The browser check also holds `/api/machines` while
asserting that the newly created restty surface mounts.

## Verification

```sh
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
bun run typecheck
bun run test:restty
bun run check fast
bun run check integration
```

With a Herdr build advertising `terminal_theme`, the dedicated theme check exercises actual PTY
queries and subscribed updates. Set `PI_THEME_QA_BIN` to also verify a real Pi UI with temporary
configuration, no personal extensions and offline mode (no model request):

```sh
HERDR_WEB_HERDR_BIN=/path/to/theme-enabled/herdr PI_THEME_QA_BIN="$(command -v pi)" \
  bun run check run bun scripts/terminal-theme-regression.ts
```

`test:restty` builds once and runs 12 scripts inside one owned, isolated herdr session. It covers
copy with denied clipboard permission; history wheel/edge selection; legacy and Kitty keyboard
protocols; composition and Safari/iPad/iPhone event replays; drafts across offline pane switches;
file/path drop and paste; split panes; WebGL2/Appearance persistence; new tabs; viewport, pinch,
search, minimal UI and SSP latency. It does not restore the removed chat/header tests or certify
physical IMEs. Full replacement of the obsolete browser lane remains a Phase 2 task.

Canvas tests read `.restty-terminal.screen()` through `scripts/terminal-screen.ts`, rather than
querying renderer DOM rows. `selection: null` means no selection; `selection: ""` can be a valid
selection of blank cells. Assertions about actual input use outgoing frames and an owned PTY.

On 2026-10-21, the whole `test:restty` lane passed, including a repeat against the patched herdr
0.9.5. Typecheck, generated-file freshness and build passed. The latest default five-worker fast
run reported 2712 passing, 8 failing and 22 skipped tests: installer/headless assumptions and
Node/Portal/plugin subprocess deadlines. An earlier run had two failures; the headless installer
failure reproduces on main and the plugin-config deadline passes alone on both branches. Not all
latest deadline failures have been independently classified as baseline. Integration against the
patched binary reported 357 passing, 2 failing and 3 skipped: attach-query reply timeout and
child-stdin-close timeout; both also reproduced on main `26e6440` with stock herdr.
These broad lanes are not green and are not reported as such.

## Startup measurements

A five-run sample on the same Mac/Chrome, 1440x900 viewport at DPR 2, built clients, isolated
sandboxes, measured time to first nonempty screen. Cold uses a fresh browser profile; warm
reloads it; new tab measures the add-button action through its first screen. These are local
samples, not a cross-device benchmark or a claim about memory/throughput.

| Median, ms | xterm main `26e6440` | restty integration |
| --- | ---: | ---: |
| Cold load | 427 | 391 |
| Warm reload | 325 | 312 |
| New terminal | 428 | 216 |

An earlier five-run sample was 323/264/361 ms on main and 360/276/191 ms on restty: startup varies
with machine load; the repeatable improvement is removing the new-tab detach/session-read cycle,
not a universal cold-start speedup. At simulated 200 ms RTT, established local-echo epochs render
subsequent keys at about 15 ms median; the first key still requires confirmation from the bridge.

Reproduce against **owned sandbox bridges only**; the script creates and closes a tab:

```sh
bun run build
bun run sandbox
# In another terminal, with CHROME_PATH exported:
RUNS=5 URL=http://127.0.0.1:7417 bun scripts/terminal-performance.ts
```

Point `URL` at a separately built main sandbox for the baseline. The renderer mark is not used by
main, so its first-screen observation polls the old renderer's nonempty rows on animation frames.

## Playground parity

The five playground payloads (`kitty`, `demo`, `test`, `ansi-art`, `colors`) were injected as
identical VT bytes into the actual local playground's mocked WebSocket backend and this app's
`ResttyTerminal` wrapper. Both had a 1200x760 viewport, DPR 2, Aizen Dark, size 18 in height mode
and WebGPU. Playground chrome was hidden without changing terminal geometry. Captures retained
the reference and wrapper images under different names, and were compared with FFmpeg's `ssim`.

| Payload | SSIM, wrapper with app fonts vs playground |
| --- | ---: |
| Kitty image | 0.998702 |
| Demo | 1.000000 |
| Capabilities/Unicode | 0.997607 |
| ANSI art | 1.000000 |
| Colours | 0.999626 |

Captured evidence: [playground Kitty reference](screenshots/restty/kitty-playground.png),
[wrapper Kitty rendering](screenshots/restty/kitty-wrapper.png),
[wrapper Unicode/styles](screenshots/restty/capabilities-wrapper.png).

These comparisons establish renderer parity only. The separate real-pane check below covers the
transport; a direct playground injection is not evidence of end-to-end support.

## Kitty graphics transport

An application prints normal Kitty APC sequences (`ESC_G...ESC\\`) to its existing PTY. There is
no second browser socket, raw-output bypass, automatic input replay or change to PTY ownership.

1. Herdr keeps its authoritative pixels and placements. Its per-pane renderer exports the
   visible scene through the existing terminal-ANSI graphics field. Per-client delivery caches
   advance only after the writer accepts the frame, including graphics-only changes. The thin
   client opts in with the named `terminal.graphics.v1` endpoint control; older peers ignore it,
   and clients that do not opt in receive no graphics. No frozen core codec changes.
2. Owned file-medium sources are copied by bounded background workers, not on the render thread:
   8 jobs, 64 MiB and 1,024 cache entries. Completion wakes rendering even when the PTY is idle.
   The attach stream uses inline pixel data, never a source-machine filesystem path.
3. The bridge's headless restty parses that attach stream. Immutable SSP scenes contain revisioned
   assets and placements/crops, bounded to 16 MiB and 1,024 visible placements. Text frames carry
   only metadata; they do not retain a copy of the pixels for every acknowledged screen.
4. Browsers opt in with `attach.graphics: true`. After a screen ACK, missing assets travel as
   `ssp-asset` messages: 128 KiB base64 blocks, a two-block acknowledged window, transport
   backpressure and bounded retries. Pixel receipts use `ssp-asset-ack`; they are never queued
   across disconnects. Silent views stop receiving retries until another screen/pixel ACK.
5. The browser validates/reassembles current assets, reconciles local Kitty IDs, and uploads via
   restty's PTY path. Replacement, deletion, crop/resize, reconnect and stream reset rebuild or
   remove images; late chunks and receipts cannot resurrect a deleted scene. Cell/input traffic
   does not wait for pixel ACKs.

Stock herdr 0.9.3 omits images from attach output, so updating only this web app cannot add them:
its attach renderer sends cells and links only, and only its own TUI receives the images. The
companion implementation is
[alexanderkreidich/herdr#1](https://github.com/alexanderkreidich/herdr/pull/1) (branch
`feat/kitty-graphics-attach` on upstream `5bd900d8`). Use a release binary built from it
(`cargo build --release`); a default debug build
uses `herdr-dev` paths, whereas this app's isolated runner expects the stable `herdr` layout.
The user's installed herdr and live sessions were not replaced. A stock binary still supplies cells and ordinary terminal input.

```sh
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export HERDR_WEB_HERDR_BIN=/path/to/patched/herdr
RENDERER=webgpu bun run test:kitty
RENDERER=webgl2 bun run test:kitty
```

The isolated test sends actual PTY output and checks canvas pixels, not an injected browser
stream: a >1 MiB RGBA image; live text while pixel ACKs stall; reconnect and late join; resize;
same-ID PNG replacement; file-medium input; scroll clipping; deletion while pixel receipts are
in flight; reload without resurrection; and pi's alt-screen redraw: a PNG with a 32-bit image ID,
then `d=a` and a cropped, placement-only `a=p` that must not send the pixels again. It saves
screenshots to the printed evidence path.
It requires the companion herdr binary and the native Node PTY sidecar, unlike `test:restty`,
which also runs against stock herdr. Mirrored `pane.read` fallback remains cell-only.
Animated Kitty frames and physical-device GPU certification are not covered by this test.

Real-pane evidence: [WebGPU](screenshots/restty/kitty-pane-webgpu.png),
[WebGL2](screenshots/restty/kitty-pane-webgl2.png), [deleted](screenshots/restty/kitty-pane-deleted.png),
pi's redraw on [the companion herdr](screenshots/restty/kitty-pane-pi.png) and on
[stock herdr 0.9.3](screenshots/restty/kitty-pane-pi-stock.png), which shows none.

Companion herdr validation at `ccd4f248`: formatting and Clippy passed; 3912 nextest tests
passed, one failed and 16 were skipped. The failing
`pane_info_and_subscriptions_expose_done_agent_status` timeout also fails on the clean upstream
`5bd900d8`. Maintenance, architecture, integration-assets and docs contracts passed. Windows
cross-lint was not run. On the earlier base `ccc7521a`, `bench-render-scale` ran, but its
native-file CoW-retention profile fails on this Mac on both branches; it is not reported green.

The added release-profile attach benchmark, measured on `ccc7521a`, holds 80x24 geometry, one
stable image and changing text, with 40 samples after 5 warmups. Median microseconds with
graphics disabled/enabled were 174/186 for one populated pane and 194/179 for 15 populated panes.
This local sample shows no pane-count multiplication of the added attach work; it is not a
throughput or cross-device claim.
