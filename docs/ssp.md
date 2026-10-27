# State Synchronization Protocol

The bridge and the browser keep a pane's screen in step the way Mosh does (Winstein and
Balakrishnan, "Mosh: An Interactive Remote Shell for Mobile Clients", USENIX ATC 2012): the bridge
sends screens, not bytes. A browser on a slow or lossy link skips the screens it fell behind on
instead of replaying them, and typing shows at once through predictive local echo. The model is
Mosh's; the code is new (Mosh is GPL-3.0).

## The pieces

| Where | What |
|---|---|
| `shared/ssp.ts` | The screen model both sides share: rows of cells (`WireRow`), styles, cursor, modes, and the difference between two screens (`FrameDiff`). |
| `server/ssp/screen.ts` | One headless terminal per attached pane (restty's libghostty-vt in WASM) fed by herdr's attach stream: the authoritative screen, numbered. |
| `server/ssp/modes.ts` | What the screen does not hold: the modes the browser's input encoding follows (mouse, DECCKM, bracketed paste, keypad, focus, modifyOtherKeys) and clipboard writes (OSC 52). |
| `server/ssp/sync.ts` | One client's sender: differences, pacing by round trip, acknowledgements, retransmission, resume; and the echo clock. |
| `shared/ssp-display.ts` | The VT output that takes a terminal from what it shows to a screen (Mosh's display). The browser draws with it; the bridge draws a screen whole with it for an older page. |
| `src/lib/ssp/view.ts` | The browser's side: the screens it was sent, local echo on top, drawn into the renderer. |
| `src/lib/ssp/predict.ts` | Predictive local echo. |

## On the wire

A client attaches with `sync: "ssp"` (the bridge lists the `ssp` feature). Each `ssp` frame is a
`FrameDiff`: the difference from screen `base` (0: a blank screen) to screen `num` of a stream, the
rows that changed (after a `scroll`, when the screen scrolled), the styles those rows use, the
cursor, the modes, a clipboard write if one is new, `echo` and `rtt`. The client applies it to the
screen it names, keeps the screens from `throwaway` on, draws the newest, and answers
`ssp-ack {stream, num}`. When only `echo` changed, the newest screen goes again with the same `num`:
the client takes its `echo` and `rtt` all the same.

A remote PC's panes are synced by that PC's own bridge, over the SSH link (docs/remote-pcs.md), so
the PC must run T-Rex's bridge: an older one (bundle versions below 1000) has no `ssp` feature,
and its panes stream raw bytes with no local echo.

- **Latest state wins.** The sender diffs from the newest screen the client is assumed to have:
  the newest one sent, while its acknowledgement is not overdue, else the newest acknowledged. A
  client that falls behind is sent the current screen next; the screens in between never go. At
  most a few unacknowledged screens are in flight, and none while the socket's queue is over
  256 KiB. Nothing pauses the pty: the screen takes everything herdr draws, whatever the clients do.
- **Pace.** A frame waits 3 ms after a change for the output that follows, then goes at most every
  half smoothed round trip (8–250 ms). The round trip is measured from acknowledgements (RFC 6298's
  estimator); the retransmission timeout doubles while acknowledgements stay away.
- **Loss and reordering.** A screen whose acknowledgement is overdue goes again, from the
  acknowledged screen. A client drops a difference against a screen it no longer has; the next
  retransmission is from one it has. (A WebSocket loses and reorders nothing, but the protocol does
  not rely on that.)
- **Joining.** A client joining a pane gets its current screen whole, drawn once herdr has drawn
  something. Nothing is replayed, and herdr is never asked to repaint for a joiner.
- **Reconnect.** A client that comes back names the stream and the newest screen it acknowledged
  (`resume`). While the pane's attachment lives (another client keeps it), the next frame is the
  difference from that screen; otherwise a new stream starts from a blank screen. Either way the
  browser diffs the new screen against what it already shows, so nothing flickers.
- **Queries.** The attach's terminal queries (device attributes, cursor position) are answered by
  the bridge's screen, never by a browser, unless an older page on the raw stream is attached: its
  own terminal answers then, as before.
- **Older pages.** An attach without `sync` gets the screen drawn whole and then the raw byte stream
  as `pty-data`. A raw client whose transport stays backed up is closed with 4008.

## Colours

Browsers have different themes, so palette colours must cross the wire as palette indices. The
headless terminal resolves every colour to RGB, so its palette and defaults are sentinels that map
back: palette index *i* draws as rgb(1, 2, *i*), the default foreground rgb(1, 3, 0), the default
background rgb(1, 3, 1). A program asking for exactly one of those truecolours gets the palette
colour instead.

## Widths

herdr gives a whole emoji sequence two cells; the screen runs in grapheme mode (2027) to agree. The
display positions every cell after a non-ASCII or wide one explicitly, so a renderer whose width
tables differ draws each cell where the bridge has it.

## Local echo

What the user types is drawn at once as a guess of the program's echo, and checked against the
bridge's screens. A guess comes true as soon as a screen shows it (in a cell that held something
else). It is wrong once the bridge says the program has had time to echo it and the screen still
does not: each `input` and `keys` frame carries a per-pane `seq`, `echo` is the newest `seq` applied
at least 50 ms before the screen, and a screen that does not show a guess yet gets 200 ms more
(herdr draws the pane at its own pace) before the guess counts as wrong.

- Printable single-width characters, Backspace and Left/Right are guessed; typing inserts.
  Anything else (Enter, control keys, a paste, a wide character, the last column, a hidden cursor)
  starts a new epoch.
- A new epoch is tentative: its guesses show only once one of them came true. A password prompt
  never echoes, so its first guess fails and nothing ever shows. The masked-prompt detection
  (`shared/secret-prompt.ts`) turns guessing off as well, as do observing and input not being ready.
- One wrong guess that was shown takes every guess back.
- Guesses show while the round trip, or the time a guessed character takes to show on a screen
  (smoothed as the round trip is), is over 30 ms (until both drop to 20 ms), or while an echo is
  late (250 ms). herdr's own pace makes an echo slow on a fast link too. Guesses are underlined
  until confirmed while the round trip is over 80 ms (until 50 ms). Only the newest cursor guess is
  judged: the screen that echoes an older one may already show newer input.

## Verification

```sh
bun test shared/ssp-display.test.ts server/ssp src/lib/ssp   # model, display, sender, local echo, convergence
bun test server/output.contract.test.ts                      # real herdr: sync, joiners, a silent observer, echo, resume, raw pages
bun run build && bun run check run bun scripts/ssp-latency.ts # a real browser through a 100 ms each-way proxy
```

`src/lib/ssp/convergence.test.ts` runs the whole path, bridge screen to sender to a link that delays,
reorders and drops frames and acknowledgements (up to 40%), across a reconnect, into the browser's
view and its display, drawn into a second headless terminal: once the program stops drawing, that
terminal shows exactly the bridge's screen, styles, cursor and modes.

`scripts/ssp-latency.ts` types `echo local-echo-works` a key at a time and times each key from the
press to its glyph on screen. Measured on an M-series Mac, herdr 0.9.3, Chrome:

| Link | First key of the line | Every key after it |
|---|---:|---:|
| 200 ms round trip, raw stream (before) | 226 ms | 232 ms |
| 200 ms round trip, SSP with local echo | 227 ms | 32 ms (median: the next frame) |
| no delay, raw stream (before) | 37 ms | 49 ms |
| no delay, SSP | 41–44 ms | 65 ms |

The SSP rows are from a headless Chrome that drew at 30 fps, so a key shown at once reads as one
33 ms frame. Without delay the time is herdr's own: it draws the pane at its own pace, about 30 ms
after the input, which is at the threshold where guesses start to show.

On a remote PC over SSH (a Hetzner server, about 80 ms round trip, typing into a shell there in a
herdr session of its own), the same typing measured:

| Bridge on the PC | First key of the line | Every key after it |
|---|---:|---:|
| an older one (bundle 31), raw stream, to the bytes' arrival (before drawing) | 73–78 ms | 69–188 ms (median 76) |
| T-Rex's, SSP with local echo | 89–98 ms | 32 ms (the next frame) |
| T-Rex's, a key every 110 ms | 87–91 ms | 2–35 ms |

## The PTY sidecar

`herdr terminal attach` runs on node-pty in a Node sidecar (`server/pty/pty-host.mjs`): loading
node-pty in Bun panics it (oven-sh/bun#18546). The sidecar stops reading the pty while its pipe to
the bridge is full, so output waits in the kernel, not in memory. The bridge itself never pauses
the pty any more: browsers that fall behind skip screens instead of holding output back. Bun's own
`Bun.Terminal` has no output pause (oven-sh/bun#41410); revisit the sidecar once it does.
