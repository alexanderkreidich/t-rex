# T-Rex

<p align="center">
  <img src="public/icons/icon-192.png" alt="T-Rex" width="100">
</p>

Your [herdr](https://github.com/herdrdev/herdr) sessions in a Ghostty-like terminal, in a browser
or on your phone, as an installable PWA.

T-Rex is built like Superlogical's [Rex](https://www.superlogical.com): a server keeps every
session running, and any window attaches to it and lets go without stopping the work. Here the
server is the [herdr](https://github.com/herdrdev/herdr) multiplexer, which owns every pty,
scrollback and agent state, and the window is [restty](https://github.com/wiedymi/restty),
Ghostty's terminal emulator for the web (libghostty-vt in WASM, WebGPU with a WebGL2 fallback).
Between the two, a Mosh-style state synchronization protocol with predictive local echo keeps
typing local on a slow link. The plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Install

Needs [Bun](https://bun.sh) 1.4+, Node 18+ and a running herdr.

```bash
herdr plugin install alexanderkreidich/t-rex   # herdr builds it and starts it with itself
```

Or from a checkout:

```bash
git clone https://github.com/alexanderkreidich/t-rex.git
cd t-rex
bun install
bun run start       # builds, then serves on http://127.0.0.1:7317
```

A native Mac app for Apple silicon (macOS 15 or later) comes with every release:
`T-Rex-<version>-arm64.zip` from the [latest release](https://github.com/alexanderkreidich/t-rex/releases/latest).
[docs/macos.md](docs/macos.md) says how to open it.

## Develop

```bash
bun run sandbox                          # disposable herdr + bridge on :7417
HERDR_WEB_API_PORT=7417 bun run dev      # Vite with HMR on :5173
bun run check fast                       # types, themes, typecheck, build, unit tests
```

See [AGENTS.md](AGENTS.md), [docs/development.md](docs/development.md) and [DESIGN.md](DESIGN.md).
Report security problems privately: [SECURITY.md](SECURITY.md).

## Credits

T-Rex would not exist without these projects, and we are grateful to their authors:

- [herdr](https://github.com/herdrdev/herdr), the multiplexer T-Rex is a window into: it keeps
  every pty, scrollback and agent alive, and T-Rex only attaches to it.
- [restty](https://github.com/wiedymi/restty) by wiedymi, Ghostty's terminal emulator for the web,
  which draws every pane.
- [Ovis](https://github.com/devswha/ovis) by devswha, the MIT-licensed herdr client T-Rex began
  as: much of the bridge and the client still derives from it.

## License

[MIT](LICENSE). Copyright © 2026 Alexander Kreidich. Third-party code and assets keep their own
licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
