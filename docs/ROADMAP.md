# Roadmap

t-rex: a browser terminal for the herdr multiplexer, built like Superlogical's Rex, with a
Ghostty-like terminal emulator ([restty](https://github.com/wiedymi/restty)) and a Mosh-style
State Synchronization Protocol.

Each phase is a few slices; each slice is one branch and one PR (AGENTS.md, Development flow).
A slice is done when its "Done when" holds, with evidence in the PR.

## Phase 0 — Development flow

- [x] AGENTS.md: product, flow, UX and motion rules, traps.
- [x] Emil Kowalski's design and animation skills in `.agents/skills/` (`.claude/skills` links).
- [x] `bun run sandbox`: an isolated herdr and bridge for UI work, with `--shot` screenshots.
- [x] This roadmap.

## Phase 1 — Minimal chrome

The visible UI shrinks to a workspace list, one top bar of pill tabs and the terminal.

- [x] **Top bar with pill tabs.** The header and the tab strip become one bar: sidebar toggle,
      then the tabs as pills (the pane's icon — agent mark or terminal glyph — and its title or the
      tab's own name), the open tab on a filled pill, `+` at the end. A status dot sits on the icon.
      The connection chip shows only while the bridge is not live.
- [x] **Header removals.** No Chat/Terminal switch, no Files button, no More (…) menu, no search
      button.
- [x] **Sidebar: workspaces only.** No Agents section; no folder or favicon face on workspace
      rows (a worktree group's mark turns to a chevron that folds it).
- [x] **Command palette on Ctrl+F.** The search button goes; Find in terminal stays on
      Mod+Shift+F and in the palette.
- [x] **No chat lens.** Every pane opens in the terminal; the lens switch shortcut, the Chat
      settings page and the palette's lens and Files actions go.
- [x] **Motion pass.** Tokens from the skills (`--ease-out`, `--ease-in-out`), press feedback on
      tabs and buttons, new tabs enter, menus and dialogs open from their origin, the sidebar
      slides; reduced-motion variants. Nothing keyboard-initiated animates.
- [x] **Focus mode** (`Mod+Shift+.`, the palette): from 769px with the sidebar shown, each
      workspace's tabs are rows under it (the pill's mark and name, the state in the status
      column; a tab with no agent reads dimmer) and the bar over the pane goes. A row moves among
      its workspace's tabs by a mouse drag (the row rises and follows the pointer, the rows step
      aside where it would land, and let go it stands in its new place while herdr makes the move,
      gliding back if herdr refuses), by Alt+↑/↓ and from its menu. Dragged among another
      workspace's rows, it goes into that workspace (`POST /api/tab/transfer`: herdr's `pane.move`
      carries each pane over with its shell, and the split layout with them; a workspace's last tab
      leaves a new shell behind, so the workspace stays). A hidden sidebar hands the tabs back to
      the bar. A split view's halves keep their own strips.
- [x] **PC switcher.** The sidebar shows one PC at a time. Its top row is a switcher (the PC's
      mark and name, a chevron with a point when another PC waits on you) whose menu lists the
      PCs, Manage for an SSH PC and Add PC, and a `+` for a new workspace at the row's far edge.
      The PC headers, their folds and the "Host" label over the list go.
- [x] **New workspace at once.** The sidebar's `+`, `Mod+Shift+O` and the palette make a workspace
      with a shell in the PC's home, no dialog; New tab (its key, the palette) is the strip's shell
      tab. The New workspace / New tab dialog, its folder browser and recent folder chips, the tab
      menus' New tab with agent… and `?new=` links go. New worktree keeps its agent picker.
- [x] **Pane cards.** From 769px the window is one recessed surface (`--bg`): the sidebar, the
      bar and the gaps around the panes. Each pane is a rounded card on it. Its title bar shows the
      pane's mark, its name (a lone pane shows its tab's name), its folder, and Split right, Split
      down, Zoom and Close. The buttons show on the open pane and under the pointer. Drag a card by
      its title onto another card of its tab and the two swap places (herdr's `pane.swap`). They
      are drawn swapped at once and slide into place (FLIP, transform only). A split made from a
      card grows in from its side. A phone keeps its edge-to-edge pane.
- [ ] Pane cards follow-ups: the browser's split view still draws a strip row per half under an
      empty bar; after a swap, Tab moves across the cards in pane order, not on-screen order (a
      section never moves in the document, so the terminal keeps the focus).
- [ ] New workspace follow-up: the bridge's `POST /api/workspace/directories` (New folder) and the
      `agent` field of `/api/workspace/create` and `/api/tab/create` have no caller in this client.
- [ ] PC switcher follow-ups: a key to switch PCs (Ctrl+1–9 is the browser's on Windows and Linux);
      the Host's name without macOS's `.local`.
- [ ] Focus mode follow-ups: the bridge says which shells run a command (`pane.process_info`), so
      a shell at work does not read as idle.
- [ ] Follow-ups: the split view's halves still draw their own strip rows under an empty bar;
      the sidebar's top zone in the bar snaps while the sidebar slides.

Done when: desktop (1440×900) and phone (390×844) screenshots in both themes show only the
workspace list, the tab bar and the terminal; `bun run check fast` is green;
`scripts/minimal-ui-regression.ts` passes; `review-animations` passes on the diff.

## Phase 2 — Delete chat and files

Phase 1 makes them unreachable; this phase deletes them, client, server, contract, scripts and
docs, so the tree is as small as the product.

- [x] Client: `ChatView`, `Composer` and the chat-only parts of `PaneTerminal`, chat timeline,
      minimap, pending messages, the chat libraries, `AgentSidebar`, the `PaneView` lens type.
- [x] Client: `FilesDialog`, `FileViewer`, `RepoDiffViewer`, `WebPanel`, file panels and their
      settings.
- [x] Server: transcript readers and conversation push (`conversation*`, `codex*`, `claude-*`,
      `gjc*`, `devin*`, `grok*`, `agy*`, OpenCode, Hermes, OmO and the rest), skills and command
      menus that only the composer used, `files.ts`, `file-view.ts`; their routes in `shared/`.
      What pane status still reads (OmO labels, Claude's background count, GJC's binding) stays.
- [x] Scripts and docs that test or describe them (chat and file browser QA, chat docs).
- [x] Server routes only the removed UI used (`/api/fs/favicon`, herdr's agent-row tokens, the
      folder listing's file and pane-relative modes).
- [ ] A lean browser lane for what is left, grown from `scripts/minimal-ui-regression.ts`, run on
      the system Chrome (`CHROME_PATH`): the old `scripts/ci-browser.sh` is already broken
      (22 of its scripts are gone, most others assume the chat, the More menu, the lens switch or
      the agent list). Keep a script only if it passes against this UI; delete the rest, and the
      demo-only scripts with them. `docs/development.md` loses the deleted scripts in the same PR.
      Done so far: the scripts for removed UI are gone, and so are their `run_script` lines and
      docs; `ui-regression.ts` (with its folder filter), the split view, mobile tabs and the
      render crash probe still reach kept UI through removed paths and are next. 17 of the 32
      scripts left fail on main (`ca0c69e`, PR #28 lists them).
- [ ] GJC's transcript lookup keeps a `purpose: "chat"` branch only status no longer takes;
      collapsing it touches the SDK timeouts and failure cache, so it is its own slice.

Done when: no `chat` lens or transcript route remains; `bun run check full` is green; the PR
lists the bundle size and line count before and after.

## Phase 3 — Own identity and cleanup

- [x] Own identity: T-Rex, its pixel T-Rex icon (`scripts/generate-brand.ts`), plugin id
      `alexanderkreidich.t-rex`, `package.json` repository, push subject, updater source (the
      checkout's `origin`), MIT under its own copyright with the original client's notice in
      THIRD_PARTY_NOTICES.md. Browser keys move from `herdr-web-ui:` to `t-rex:` on first load;
      an existing `~/.config/herdr-web-ui` stays the state dir until moved to `~/.config/t-rex`.
- [x] Remote PCs run T-Rex's bridge: the bundle URL names this repository and its versions
      start at 1000, so a PC on an older bridge (no SSP, no local echo) is offered Update bridge.
- [ ] Publish `remote-v1000` from this repository; until then a remote PC needs a bundle built
      beside the server (`bun run build:remote <platform>`, docs/remote-pcs.md).
- [x] Remove usage telemetry: sender, daily visits, settings snapshots, API, UI, receiver
      and reporting/deployment tooling.
- [x] README; the website, its film and README media, the one-line installers, the native shells
      (`app/`) and the old changelog, release summaries and release workflow are gone.
- [ ] DESIGN.md trimmed to what is left; `docs/guide.md` rewritten without the chat (its
      Supported agents and Features sections describe it).
- [ ] CI: one GitHub Actions workflow running `bun run check fast` on PRs; the self-hosted-runner
      setup goes.
- [x] What else leaves: the plan meters and CLIProxy hub, voice input, Portal, in-app alerts
      (Droplet) and the alert sound, the sidebar's Install app button (Settings keeps Install),
      Markdown with KaTeX, Mermaid and highlighting (the update notes draw their changelog
      section directly), the recorded agent fixtures and the browser scripts for removed UI.
- [x] Kept: the agent integrations that read pane status (OmO, GJC, Claude's subagents and store,
      background waits), push alerts, remote PCs and the ko/ja/zh translations.

## Phase 4 — restty terminal

Replace xterm.js with restty: libghostty-vt in WASM for VT parsing and state, WebGPU rendering
with a WebGL2 fallback, TypeScript text shaping.

- [x] Native runtime selected, pinned to the `alexanderkreidich/restty` fork. No compatibility
      renderer or xterm fallback remains. Startup/input and playground comparisons are in
      [restty integration](restty.md).
- [x] `PaneTerminal` on restty: the attach stream in; keys, IME, paste and mouse out; selection
      and copy, links, search, resize and fit, the mirrored (read-only) pane.
- [x] Ghostty look: themes from Ghostty's palette set, font rendering and ligatures, cursor
      styles. xterm, its patches and `scripts/build-xterm.ts` go.
- [ ] Follow-up measurements: large-output frame time, memory and bundle-size comparison;
      repeat physical IME/device QA against restty (recorded-event browser replays pass).
- [x] Kitty graphics end to end with the companion herdr `feat/kitty-graphics-attach` branch:
      authoritative attach scene, bounded/acknowledged SSP pixel chunks and native reconciliation.
      Real-pane WebGPU/WebGL2 checks cover large RGBA, PNG/file medium, stalled pixel ACKs with
      live text, joins/reconnect, resize/crop, deletion and pi's placement-only redraw. Stock herdr
      still needs that patch ([alexanderkreidich/herdr#1](https://github.com/alexanderkreidich/herdr/pull/1)).
      See [transport and reproduction](restty.md#kitty-graphics-transport).

Done when: the terminal input, IME, paste, copy and selection regressions pass on restty, and the
PR shows the measurements against xterm.js. `bun run test:restty` is the owned terminal browser
lane; renderer-only Kitty evidence must not be represented as herdr/SSP end-to-end support.

## Phase 5 — State Synchronization Protocol

Mosh's model for the bridge–browser link: synchronize screen state, not a byte stream. Done ahead
of Phase 4: the browser draws the synced screen into its renderer with VT output
(`shared/ssp-display.ts`), so it does not depend on which renderer that is, and it gives the
browser the screen as data, which the restty slice can read instead of a renderer's buffer.
See [ssp.md](ssp.md).

- [x] **Bridge screen state.** One headless terminal (`restty/headless`) per attached pane, fed by
      herdr's attach stream: the authoritative state, numbered.
- [x] **Sync.** The bridge sends the difference from the state the client last acknowledged to
      the current one; the client applies it and acknowledges. Latest state wins: a slow or
      backgrounded client skips intermediate frames instead of replaying them, and a reconnect
      resumes from its last acknowledged state. Frame rate follows the measured round-trip time.
- [x] **Predictive local echo.** As Mosh: predict printable characters, backspace and cursor
      moves on the current line; group predictions in epochs and show them only once an epoch is
      confirmed by the server's state; underline unconfirmed predictions when the link is slow;
      roll back on mismatch; never predict while the terminal does not echo (passwords).
- [x] **Measure.** A harness with simulated latency and loss; typing at 200ms round trip feels
      local, and the screen converges to the bridge's state after loss.
- [ ] Follow-ups: a tab out of use still draws herdr's read-only view (`watch-data`) from its raw
      stream, and a mirrored pane's screen is synced but polled as before; a Settings choice for
      local echo (adaptive, always, never) if adaptive turns out wrong for someone.

Done when: correctness tests (convergence under loss, reordering and reconnect) and the latency
harness pass, and the old flow-control path is gone.

## Phase 6 — Releases

- [x] **Release train**: a `vX.Y.Z` tag that names the version in `package.json` and
      `herdr-plugin.toml` publishes the GitHub release, with its CHANGELOG.md section as the notes
      ([development.md](development.md#releases)). Installed plugins are offered it.
- [x] An Electron Mac app (#32) shipped in 0.1.0's release, then was removed with its downloads:
      a Mac app, if one comes, is native.
- [ ] **Native Mac app** (`macos/`, [macos.md](macos.md)): Swift and AppKit with the system's
      WebKit, the window drawn as the installed app is in Chrome, the bridge inside. Every release
      carries it (`release.yml` builds it with `mac-app.yml`): no Intel build, no Developer ID.
