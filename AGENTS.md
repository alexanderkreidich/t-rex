# T-Rex

A browser terminal for the [herdr](https://github.com/herdrdev/herdr) multiplexer, built like
Superlogical's [Rex](https://www.superlogical.com): herdr keeps every session, and the browser
attaches to it through a Ghostty-like terminal emulator and a State Synchronization Protocol.

A browser client for the herdr terminal multiplexer: a React 19 client (`src/`), a Bun bridge
(`server/`) that talks to herdr's unix-socket API, and the wire contract both import (`shared/`).
herdr owns every pty, scrollback and agent state; this app is a bridge and a terminal.

The plan, phase by phase, is in [docs/ROADMAP.md](docs/ROADMAP.md). Read it before starting work:
it says what is being removed, what is being built, and what "done" means for each slice.

## Product

1. **Terminal first.** One fast, beautiful terminal surface. Rendering moves from xterm.js to
   [restty](https://github.com/wiedymi/restty) (libghostty-vt in WASM, WebGPU with a WebGL2
   fallback, TypeScript text shaping): Ghostty's VT behaviour and look in the browser.
2. **State Synchronization Protocol.** Mosh's model between bridge and browser: the bridge keeps
   the authoritative screen state of each pane and sends the client the difference from the last
   state the client acknowledged; latest state wins, nothing is replayed. On top of it the client
   runs Mosh-style predictive local echo, so typing feels local on a slow link.
3. **Minimal chrome.** The sidebar lists workspaces and nothing else; one top bar carries pill
   tabs; no chat, no file browser, no overflow menus. What is not used every session lives behind
   a shortcut or the command palette (Ctrl+F).
4. **Feels right.** Smooth where motion helps, instant where it would slow you down. See
   [UX and motion](#ux-and-motion).

Removed for good, not hidden: the chat lens and composer, agent transcript readers, Files and the
file viewer, the sidebar's Agents list, the header's More menu and search button. Code from them
still in the tree is dead code waiting for its deletion slice, not a pattern to extend. Never add
them back.

## Development flow

- One slice per branch, cut from `main`: `feat/…`, `fix/…`, `refactor/…`, `chore/…`, `docs/…`.
  A slice is one roadmap item, small enough to review in one sitting.
- Pull requests go to this repository, named explicitly so `gh` never picks another:
  `gh pr create -R alexanderkreidich/t-rex --base main`.
- Commits and everything on GitHub are in English, Conventional Commits
  (`feat(tabs): …`, `refactor(chat): delete the transcript readers`).
- A release is a `vX.Y.Z` tag on `main`, cut as [docs/development.md](docs/development.md#releases)
  says: every installed plugin's updater offers it, so tag only what is ready. Its notes are its
  CHANGELOG.md section (no changelog fragments).

The loop for a UI slice:

1. Read the roadmap item and the skills it needs (below).
2. Run a disposable herdr and bridge: `bun run sandbox` (herdr session `restty-sandbox`, bridge on
   127.0.0.1:7417), then `HERDR_WEB_API_PORT=7417 bun run dev` for Vite with HMR on :5173.
3. Implement. When the roadmap says remove, delete the code, its CSS, its i18n entries and its
   tests; do not leave a disabled path behind.
4. Verify:
   - `bun run typecheck`, the tests next to what changed (`bun test src/lib/foo.test.ts`),
     `bun run build`;
   - screenshots: `bun run build && bun run sandbox --shot /tmp/desktop.png` and
     `--size 390x844` for a phone, `--theme light` when colours change. Look at them;
   - the browser check of the minimal UI:
     `bun run build && bun run check run bun scripts/minimal-ui-regression.ts`; extend it when a
     slice changes what it checks;
   - `bun run check fast` before a PR (generated types and themes, typecheck, build, unit tests).
     Changes to `server/`, `shared/` or terminal I/O also run `bun run check integration` (a herdr
     of its own). The old browser lane still assumes the chat and the old header: it is being
     replaced (roadmap, Phase 2), so do not chase its failures from removed UI.
   - after removing UI, `bun scripts/i18n-prune.ts` drops the translations nothing asks for.
5. Run the `review-animations` skill over a diff that touches motion; fix what it blocks. One-off
   probe scripts (screenshots mid-animation and the like) go in `scripts/*.tmp.ts`, which git
   ignores.
6. Commit, push the branch, open the PR with before/after screenshots.

Stop the sandbox's herdr when done: `herdr --session restty-sandbox server stop`.

## UX and motion

Skills for this live in `.agents/skills/` (Emil Kowalski's, MIT; `.claude/skills` links to them):
`emil-design-eng` (principles), `animate` (build one), `review-animations` (before a PR),
`improve-animations` (audit), `find-animation-opportunities`, `animation-performance`,
`animation-vocabulary`, `apple-design`, `mobile-native`, `break-ui`, `prototype` (try variants of a
UI piece behind a switcher before committing to one).

- Gate every animation by how often it is seen. Keyboard-initiated or 100+ times a day (palette,
  tab or pane switching by key, focus moves): no animation. Tens a day (hover, press): near
  imperceptible. Occasional (menus, dialogs, sidebar, a new tab): standard.
- Durations: press 100–160ms, tooltips and small popovers 125–200ms, menus 150–250ms, dialogs
  and drawers 200–300ms. Nothing in the UI over 300ms.
- Easing: entering and exiting `ease-out`, moving on screen `ease-in-out`, colour and hover
  `ease`; never `ease-in`. Use the tokens in `src/styles.css` (`--ease-out`, `--ease-in-out`,
  `--ease-spring` for drawers, `--dur-*`), never an ad-hoc curve.
- Animate `transform` and `opacity` only. Never from `scale(0)`: start at 0.95–0.97 with opacity 0.
  Popovers grow from their trigger; dialogs stay centred.
- Transitions, not keyframes, for anything that can be triggered again mid-flight;
  `@starting-style` for entrances.
- Hover motion only under `(hover: hover) and (pointer: fine)`. Every animation ships with its
  `prefers-reduced-motion` variant: keep opacity and colour, drop movement.
- Never animate something that resizes the terminal frame by frame (each fit is a pty resize):
  change the layout once and animate an overlay.
- Minimalism is a rule, not a style: an element earns its place by being used every session. A
  new button, icon or label needs a reason, and preferably replaces one.

## Bridge traps

- Never load node-pty inside Bun: it panics the runtime. PTY work goes through the Node sidecar.
- Never pass `--takeover` to `herdr terminal attach` on the server's own initiative; it cuts off
  whoever holds the pane. Only a user's explicit take-over request may.
- One herdr RPC connection per call: herdr closes the socket after each answer. Only
  `events.subscribe` stays open, and a second subscribe on it is ignored, so reopen with the full
  set. Caching answers is fine.
- `pane.process_info` takes `pane_id`, not `target` (with `target` herdr answers for the focused
  pane).
- The attach stream is the truth for a pane's screen. Never rebuild an attached terminal from
  `pane.read`; only a mirrored pane (no attach: Windows, or no Node for the sidecar) is drawn from
  it, so never assume a pty exists. The SSP state is derived from the attach stream on the bridge.
- Nothing the user typed is sent automatically after a disconnect: it waits in a draft until the
  user sends or discards it. Local echo predictions are display only and never resend input.
  Typing on a live connection while a pane just picked opens its input is typeahead: it reaches
  the pane once herdr says the input is ready, and goes to the draft on a drop, a refusal, the
  pane put away, or no answer in `TYPEAHEAD_MS` (PaneTerminal). Masked input is never kept.
- Prompt answers go through `POST /api/pane/prompt/answer`, never guessed digit keys.
- Selecting a pane or tab in the browser never moves herdr's own focus; only an explicit action
  that needs it calls `pane.focus`.
- Never edit `shared/herdr-api.generated.ts`; run `bun run generate:types`.
- Theme colours are edited only in the theme blocks of `src/styles.css`. Never edit
  `src/lib/themes.generated.ts` or the generated copies in DESIGN.md, index.html and
  `public/manifest.webmanifest`; run `bun run generate:themes`.
- Usage telemetry is gone for good: never add reporting to a third party.

`server/AGENTS.md` and `src/AGENTS.md` hold the traps local to each side. Code conventions
(imports, CSS tokens, i18n entries, fixed sleeps, wording, icons) are enforced by the
`conventions.test.ts` files, whose failures say what to change.

## Tests and QA

- Tests never touch the user's herdr session or real state: they use the isolated test session,
  a `mkdtempSync` `stateDir` and `port: 0` for every `createServer`. Never run the real
  `herdr update` in a test.
- Screenshots and recordings come from the sandbox, the demo or a test session, never the user's
  live one.
- A server started for someone else to open binds to loopback or the Tailscale address
  (`HOST=$(tailscale ip -4)`), never `0.0.0.0`.
- When a removal makes a test meaningless, delete the test with the code. Do not keep tests alive
  for dead features, and do not weaken a test of a kept feature to make a removal pass.
