# Changelog

Versioned with [semantic versioning](https://semver.org/). Each release is a `vX.Y.Z` Git tag;
installs update only to releases. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

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
