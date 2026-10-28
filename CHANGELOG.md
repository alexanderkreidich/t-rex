# Changelog

Versioned with [semantic versioning](https://semver.org/). Each release is a `vX.Y.Z` Git tag;
installs update only to releases. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

## [1.1.0] - 2026-10-28

### Added

- Added collapsible workspace tabs in focus mode: click a workspace row to fold or unfold its
  tabs. (#2)

### Changed

- Made pane splits visible at the click, with the new terminal attaching as soon as herdr
  answers instead of waiting for the next workspace snapshot. (#6)
- Made closing a pane or tab update the layout and select its neighbour immediately; a refused
  pane close restores the card. (#7)
- Reduced the delay before a freshly attached terminal shows its screen and accepts input,
  while retaining the settling period for contested or recently resized terminals. (#5)

### Fixed

- Updated clients as soon as herdr answers a pane split, close or zoom, or a tab or workspace
  close, without waiting for its next event. (#3)
- Kept herdr's terminal-attach shutdown messages out of the pane's terminal when a pane closes,
  its shell exits or the server stops. (#4)

## [1.0.0] - 2026-10-27

The first official release of T-Rex, in a repository of its own: your herdr sessions in a
Ghostty-like terminal, in a browser, on your phone and in a native Mac app.

An install of 0.1.0, which came from the earlier fork, does not update to this release: install
the plugin again with `herdr plugin install alexanderkreidich/t-rex`.

### Added

- The terminal is restty: Ghostty's terminal emulator (libghostty-vt in WebAssembly, drawn with
  WebGPU or WebGL2), with Ghostty's themes, ligatures and cursor styles. The terminal's colours
  follow the system's light or dark appearance.
- A Mosh-style state synchronization protocol between the bridge and each window: a slow window
  skips to the latest screen instead of replaying it, and predictive local echo keeps typing
  local on a slow link.
- Minimal chrome: the sidebar lists workspaces, one PC at a time behind a switcher; one top bar
  carries pill tabs; each pane is a card with a title bar, and dragging a card by its title swaps
  it with another.
- Focus mode, on by default: the sidebar lists each workspace's tabs, which drag to reorder or
  into another workspace (or move with Alt+↑/↓).
- Keys: the command palette on Ctrl+F, a new tab on Mod+N, a new workspace with a shell in home
  on Mod+Shift+O, split right on Mod+D, the sidebar on Mod+B.
- A native Mac app for Apple silicon (macOS 15 or later): an AppKit window with the system's
  WebKit and the bridge inside, with macOS notifications when an agent finishes or needs input.
  It joins the herdr plugin's bridge when one runs. Each release carries it as
  `T-Rex-<version>-arm64.zip`; see [docs/macos.md](docs/macos.md).
- Installed as a herdr plugin (`alexanderkreidich.t-rex`), T-Rex updates to these releases from
  Settings.

### Removed

From the web client T-Rex began as ([Ovis](https://github.com/devswha/ovis)): the chat view and
composer, agent transcript readers, Files and the file viewer, the Agents list, voice input, the
Portal public address, plan meters and the CLIProxy hub, in-app alert cards and their sound,
Markdown rendering, and usage telemetry.
