# User guide

[← README](../README.md) · [Quick start](#quick-start) · [Supported agents](#supported-agents) · [Features](#features) · [Phone](#on-your-phone) · [Remote PCs](#remote-pcs-over-ssh) · [Access and safety](#access-and-safety) · [Configuration](#configuration) · [Updates](#updates) · [Keyboard shortcuts](#keyboard-shortcuts) · [How it works](#how-it-works) · [FAQ](#faq)

Install, connect and use T-Rex on your desktop and phone.

## Quick start

You need [herdr](https://github.com/herdrdev/herdr) 0.9.0+, [Bun](https://bun.sh) 1.4+ and Node 18+
(Node runs the terminal sidecar), with herdr installed and running first: start it with `herdr`.

**1. Install it** as a herdr plugin:

```bash
herdr plugin install alexanderkreidich/t-rex
```

herdr builds it and starts it along with itself, on `127.0.0.1:7317`, following the socket of the
current herdr session. When herdr is already running, the app starts now. Choose the plugin's
**Phone setup** action inside herdr to see the phone address, its QR code and a pairing code.

**Or from a checkout:**

```bash
git clone https://github.com/alexanderkreidich/t-rex.git
cd t-rex
bun install
bun run start
```

`start` builds the client and runs the server under the update supervisor. It talks to `~/.config/herdr/herdr.sock` unless `HERDR_SOCKET` says otherwise. If herdr isn't running there, the app still opens, but its header shows **herdr offline** and the page says it cannot reach herdr at that socket.

**2. Open it** at **http://127.0.0.1:7317**. The installed app belongs to that exact address: `localhost:7317` is another address to the browser, so a tab there still offers **Install**. Every workspace of your herdr session is a row in the sidebar, as in herdr's own, led by its project's icon when its folder keeps one (a favicon in the folder, `public/` or `static/`; else an app icon such as Next.js's `app/icon.*` or Electron's `build/icon.png`; else a logo such as `logo.svg` or `assets/logo.png`; the folder is the worktree checkout, or else the pane's working folder, so a pane that has `cd`'d into `src/` looks there) and a folder glyph otherwise (a repository row with worktrees under it is also its fold button: the folder opens and closes with it, and an icon turns into that folder under the pointer; the worktree rows nested under it have no mark); its tabs are always shown in a strip, and the active tab shows all its split panes together. Pick one, open a shell in your home folder with **New workspace** (the sidebar's `+`), or add a shell tab to a workspace with **New tab** (the strip's `+`, or the command palette on a wider screen or with a keyboard). Right-click a tab to rename or close it; on a phone, tap the selected tab’s **⋯** for a trimmed menu with pane actions, Rename tab and Close tab. A focused tab also opens its menu with Shift+F10, and double-click still renames it.

Drag a tab to change its order within the workspace, or choose **Move tab left / right** from
its menu (also on a phone). Alt+Shift+Left/Right moves a focused tab. Reordering keeps the
selected pane and saves the order in herdr.

Right-click a pane to rename it, split right or down, zoom it, or close it. Right-clicking another
pane keeps the current focus, so **Swap with focused pane** exchanges the two. Drag a boundary
to resize it. On a touch screen, the pane header's **⋯** opens the same menu; on a phone the tab's **⋯** carries
the open pane's Rename and Close, while split and zoom stay with a screen that shows panes side by
side. **Unzoom pane** stays in the phone's tab menu when the tab is zoomed, so its other panes
remain reachable. **Zoom pane** makes a small pane fill the screen, and **Unzoom pane** restores the split. A split opens the new pane.
Each pane keeps its own Chat/Terminal view and unsent draft.

To see two panes side by side, drag a workspace row, an **Agents** row, a tab, a pane's title or
a half's bar onto the left or right half of the pane area. A pick in the sidebar or the **Agents**
list then opens in the active half only, and the focus stays there. Both halves can show the same
tab, and you type in whichever half is active; the other half shows that tab at the active half's size.


**3. Take it with you.** Scan the QR code of **Phone setup** with a phone signed in to the same Tailscale account, then install the app from the browser. See [On your phone](#on-your-phone).

### In a terminal

**The phone address, again:** choose the plugin's **Phone setup** action, or run `bun scripts/plugin.ts phone` from a checkout. It prints the address and its QR code, serving the app to your tailnet first if nothing does yet.

**A pairing code, on a PC with no browser of its own:**

```bash
root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "alexanderkreidich.t-rex")?.plugin_root ?? "")')
bun "$root/scripts/plugin.ts" pair   # plugin install
bun scripts/plugin.ts pair           # from a checkout
```

`pair` prints the code, the address the phone opens when Tailscale serves one, and that address as a QR code. Neither is a herdr action: herdr keeps an action's output in its log, and a pairing code belongs on the screen. The actions start, stop and report on the server:

```bash
herdr plugin action invoke alexanderkreidich.t-rex.start    # leaves a running server alone
herdr plugin action invoke alexanderkreidich.t-rex.status
herdr plugin action invoke alexanderkreidich.t-rex.phone    # visible phone setup pane
herdr plugin action invoke alexanderkreidich.t-rex.stop
```

Its PID and log live under `HERDR_PLUGIN_STATE_DIR`. For persistent settings (see [Configuration](#configuration)), add `KEY=value` lines to the `env` file (no dot) in the directory that `herdr plugin config-dir alexanderkreidich.t-rex` prints. A plugin checkout from 0.3.25 on also reads `.env` there, which wins where both set a key; an older one needs a plugin reinstall first, since in-app updates do not replace the checkout. The plugin's `status` prints the files it read. Protect that file if it holds a token.

### Uninstall

```bash
herdr plugin action invoke alexanderkreidich.t-rex.stop
herdr plugin uninstall alexanderkreidich.t-rex
tailscale serve --https=<port> off    # the port Phone setup printed, if it served the app
```

Push keys and paired devices are in `~/.config/t-rex`.

## Supported agents

Every agent herdr runs shows up with its live status, terminal and alerts. The chat view reads the agent's own session files wherever it knows where they are:

| Agent | Chat | Answer prompts from chat |
| --- | --- | --- |
| **Claude Code** | Native transcript, resolved through herdr | ✓ approvals, questions, plan and menu picks, and the `/model` list (picked for the session) |
| **Codex** | Native rollout, with tool results and commentary/final phases | ✓ approvals and questions, including queued ones, and the `/model` lists (picked for the session) |
| **omp** | Native session file | ✓ |
| **omo** | Native session file, found through the pane's process tree | ✓ the `/model` list (picked for the session); other menus — use Terminal |
| **gjc** | Native session file identified by GJC's SDK broker and the pane's process | — use Terminal |
| **pi** | Native session file, resolved through herdr; after `/tree`, the branch in play | ✓ its dialogs: a question, a confirmation, an answer typed in |
| **Command Code** (`cmd`) | Native session file under `~/.commandcode/projects/`, resolved through herdr; after `/tree`, the branch in play | ✓ its permission prompts: Yes / Yes, don't ask again / No |
| **OpenCode** | Native session in OpenCode 2's own database, resolved through herdr: `~/.local/share/opencode/opencode.db` (`%USERPROFILE%\.local\share\opencode\opencode.db` on Windows), or where the server's `XDG_DATA_HOME` or `OPENCODE_DB` puts it | ✓ its questions on OpenCode 2.0 or later, answered through its background service (`~/.local/state/opencode/service.json`, or under the server's `XDG_STATE_HOME`) one question at a time, with Back to change an earlier one; other prompts, and OpenCode 1 — use Terminal |
| **Devin CLI** | Native SQLite session, showing the active branch when herdr or the live process explicitly identifies the session; otherwise terminal text | — use Terminal |
| **Grok** | Linux native update log. Any Grok executable named `grok` or `grok-…` that holds the `events.jsonl` for the session Herdr reported in exactly one directory, with a newer write time than every other held session. Older open files do not hide it; ambiguous IDs, tied times, and an unreported `/resume` use Terminal until Herdr names the confirmed session. macOS and Windows use Terminal. | — use Terminal |
| **Hermes** | Native SQLite session store | — use Terminal |
| **Antigravity (agy)** | **Experimental; macOS untested.** Native ledger, selected by the running process’s held conversation lock. Linux native-tested; Windows uses terminal text. | — use Terminal |
| **Anything else** | The terminal's text | — use Terminal |

GJC chat requires GJC 0.18.9 or later for its broker-bound SDK session CLI, with `gjc`
on the server PC's PATH and its SDK broker already running. An older GJC opens in Terminal.
Git must also be on PATH for the SDK's workspace-scope discovery.
The bridge asks the broker which saved session belongs to the pane's GJC process;
it does not start a broker or guess from the screen, session title or newest file.
Missing, ambiguous or unreadable SDK identity uses Terminal instead. Terminal input,
status tracking and prompt handling are unchanged.

Devin sessions are never selected by directory or recency alone. A plain `devin` shows the
terminal text, since herdr does not report its session without its Devin integration; a session
started with `devin --resume <id>` (or `-r <id>`, as Devin suggests when it exits) is a chat.
Missing, ambiguous or
unreadable history uses the terminal-text fallback, including histories beyond the reader's
5,000-node or 8 MiB bounds. Long tool output is shortened with a truncation marker; use
Terminal for the rest. The database is opened read-only, though SQLite may create its
WAL coordination files beside it.

When the last visible line is a familiar password, SSH passphrase or PIN request, both
views show a **Password or PIN** field. It hides what you type and sends it directly
to the terminal with Enter. The value is cleared on send, cancel, disconnect, pane
change or when the page goes into the background. It never enters the message queue,
draft storage or chat history. A changed prompt or busy pane refuses the send; check
the terminal before entering it again. **Cancel** sends Ctrl+C. Remote PCs need bridge
bundle v6. Detection covers a narrow list of English prompts, not every program or language.

A ring by the message box shows how much of the model's context the last request filled, and
its exact token counts on a tap. A pi pane shows it once `~/.pi/agent/models.json` states that
model's window, which is the file pi reads its own providers from; a model it states no window
for shows no ring rather than a guessed one, because pi answers those from a catalogue or a
running llama.cpp server that this app cannot ask. The model and reasoning effort come from what the session recorded, never from answer text. A todo list shows where the agent recorded it, in the turn's work block: Claude Code's `TodoWrite`, Codex's `update_plan`, or omp, omo and gjc todo calls. Plain-text plans are not reconstructed, and Claude Code `TaskCreate` / `TaskUpdate` calls are not drawn in the work block: the task list they build is the pane's plan, below.

Background tasks have a button by the message box, with a count while some run: an OmO pane's `task` children, and a Claude Code pane's subagents (the `Agent` tool), read from the session's own files. A Claude Code pane's background commands (`run_in_background`, Ctrl+B, or one moved there by its timeout) are listed with them. It lists what runs and the newest ten that ended in the last day, and the sidebar badge shows the running count. A Claude Code turn that ends while work it started still runs reads **BG**, not DONE: that work's notice starts the next turn by itself, and the finish is alerted once, when that turn ends (a turn is held at most 30 minutes). A subagent that ends leaves a card in the chat with its answer, and a Claude Code subagent whose pane no longer runs that session reads as lost.

A pane's plan is the task list a Claude Code agent keeps (`TaskCreate` / `TaskUpdate`) or the checklist Codex keeps (`update_plan`), read back from the session's transcript. While there is one, the background-task button by the message box starts with **Plan** and how many of its steps are done (`2/5`); the same button opens one list with the plan's steps first and the background tasks below. Steps are listed so a step comes after the steps it waits on (Claude Code's `blockedBy`; a Codex step waits on the one before it). The running step says what it does now, and each step shows how long it took. The sidebar row carries the same count. Claude Code empties its task list once every task is done, and so does this: the first task after that starts a new plan. A teammate of an agent team that changes a task writes that in its own transcript, which is not read.

## Features

| | |
| --- | --- |
| **Read the conversation** | Prompts and Markdown answers (links, code blocks, tables). Each turn's commands, edits and progress are folded into one "Worked for …" block. Copy an answer as Markdown or plain text. In a pi pane, a picture the agent's own tool opened shows inside that tool's row. A picture opens in a full-screen viewer: zoom at the pointer, pan, step through the message's other pictures, **Copy image** and **Download**. Skill names an answer writes (`/name`, or `$name` for Codex) show as chips when the pane's own command list names that skill. Once you have sent four or more messages, a rail of dashes at the left, one per message you sent, jumps between them (not on a phone, or when the chat column leaves less than 32 px of margin at each side). |
| **Follow the plan** | A supported todo-tool call folds into the turn's work block like any tool: it reads as the done count or the step it took, and opened, as the whole list by phase. |
| **Drop into the real terminal** | xterm.js on the live pane: full-screen TUIs, raw keys and herdr's scrollback, shared with your own herdr TUI. Drag to select and it is copied on release; the wheel or the screen's edge scrolls further back while you drag. Ctrl+C copies a selection instead of interrupting. **Quote in message**, shown while text is selected, adds the selection to that pane's chat draft in a code block headed by the pane name, and its line numbers when herdr reports them; nothing is sent. |
| **Find in terminal** | **More → Find in terminal** or Mod+Shift+F searches literal text in herdr's history, with a match count, previous/next navigation and visible match highlights. Search jumps and scrolling move the same viewport in every attached client, including the TUI. Older bridges retain search navigation without automatic highlights. |
| **Jump across PCs** | The command palette (Mod+Shift+K) searches all connected PCs at once by PC, workspace, branch, tab, pane title or agent kind. PC names distinguish results, and Recent remembers each pane's PC. Picking a result opens that PC and pane directly. Disconnected PCs are omitted; app and plugin actions remain on the currently selected PC. It also finds Settings pages and actions by related words (try `theme` or `font`), and browses folders: type a path such as `~/`, or pick **Browse folders**, and the folder you reach opens in Files. |
| **Answer prompts** | Approval, question and plan menus become cards. Tap an option, or type its number in the composer. The server checks that the menu is still current before answering. |
| **Compose** | `/` commands and `@` file mentions, any file or image up to 32 MB attached by path, and a draft per pane. Send during work schedules a next-turn message; use its ↑ Send now action to send it now. A strip under the input card names the pane's working folder (the whole path on hover) and, for a workspace of a repository with a worktree open, its branch at the other end; a phone leaves it out. |
| **Follow every agent** | Live RUN / INPUT / DONE / READY status for all panes, and alerts when an agent needs input, finishes or its terminal ends. |
| **Open what agents make** | A file path in an answer opens in a viewer (images, video, audio, PDF, text), or find it with **Browse files**, and download it to your phone. A source file opens whole up to 8 MB and 200,000 lines; past 2,000 lines it scrolls as a window of rows, colored up to 256 KB and 5,000 lines and plain beyond. A link with `:line` or `#L12` opens at that line. |
| **See what changed** | **Browse files → Changes** lists what changed in the git repository the pane sits in: the **Working tree**, what is **Staged**, or two **Commits** you name, as a folder tree with git's status letter and the added and removed lines. A row opens its diff, **Unified** or **Split** (Settings → Chat → File viewer → Diff layout; a phone shows one column), with **Copy path**, **Copy patch** and **Open file**. The files a turn's edit tools changed, listed in its work block, open the same diff. It only reads; a remote PC's repository is read on that PC. |
| **Manage sessions** | Start a workspace, a shell in your home folder, with no dialog. Add a tab to a workspace (as herdr's prefix+c), switch tabs from the strip over the pane, rename workspaces from their ⋯/right-click menu and panes from their own menu, reorder workspaces (drag a row, or on a phone long-press it and drag; Alt+Up/Down moves a focused row one step), and jump anywhere from the command palette. |
| **Make it yours** | English, Korean, Japanese or Simplified Chinese, following the browser or chosen in Settings. Dark, light or system mode, with a dark theme and a light theme picked from Amber, Charcoal, Catppuccin and herdr's built-in themes, compact density, interface size, terminal and chat fonts and sizes (Chromium lists the installed fonts to pick from), a resizable composer, Enter behavior and thinking visibility. |

Every agent has the same chat controls on desktop and phones: Stop while it works with an empty
draft, Send when you type, and Send at rest. With a draft in the box, Escape stops the agent. Sending during work adds a message bubble above the
input card. It waits for the current response, then goes to the agent's next turn. Use a pending message's
**↑ Send now** action to send it now. The bridge immediately delivers it; when the agent reads
it is controlled by that agent, so this does not promise instant interruption. The small X discards it.
The bridge claims the same message ID for Send now and an automatic send, so they cannot both
deliver it. Older bridges keep the draft and ask for an update instead of changing queueing into
an immediate send. Connection loss pauses automatic delivery; uncertain text can be copied or
discarded after checking the terminal. Previously held browser messages still need **Send now**
or **Discard**. A message is never pasted over text typed in Claude Code's own input box: while
that box holds a draft the message stays in the list with the reason, and **Send now** delivers it
once the draft is sent or cleared in the terminal.

## On your phone

Serve the app over **HTTPS** to install it and receive push alerts. The simplest way is Tailscale: keep the server on `127.0.0.1` and let Tailscale add the HTTPS address.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7317
```

**Phone setup** runs this for you when Tailscale runs on the PC and does not serve the app yet, on the first free port of 443, 8443, 7317 and 17317, and prints the command that undoes it. On Linux, `tailscale serve` needs root or `sudo tailscale set --operator=$USER` once; Phone setup says so when Tailscale refuses.

Only devices in your tailnet can open that address. Your own devices get in without a code as it is: `tailscale serve` states your login. If your own phone is asked to pair anyway, `HERDR_WEB_TAILSCALE_SERVE_ONLY=1` lets it in without a code on a tailnet one login owns, and only when nothing else, such as a public reverse proxy or tunnel, reaches this port (see [Access and safety](#access-and-safety)). Devices that belong to someone else pair with a six-digit code.

**Settings → Phone & devices** in the app does this step for you as far as it can: it shows the address Tailscale already serves for this PC as a QR code, or the exact command still to run, and the address it will give.

1. Open the address.
2. Install the app: in Safari, choose **Share → Add to Home Screen**; in Chrome, choose **Install app**. Each PC installs as an app of its own: set `HERDR_WEB_APP_NAME` on each to tell them apart (see [Configuration](#configuration)).
3. Open the **⋯** menu at the top right and tap **Alerts** to turn on alerts for that device. iPhone needs iOS 16.4+ and the home-screen app.

To check alerts later, choose **Settings → Alerts → Send test**. The result tells you
whether the test was sent or failed; a missing subscription offers **Turn alerts on again**.

While the app is in front on any device, its window visible and focused, no alert goes to any
device: you are already looking at the change. Alerts resume once no window of the app is in use.
The test push is always sent.

On a phone:
- Agent panes open in the chat.
- The terminal gets a key bar above the keyboard (Esc, Tab, Ctrl+C, Ctrl, Alt, Shift, Enter, arrows).
  Ctrl, Alt and Shift stay held until tapped again and combine with each other.
  The terminal starts in direct typing, where they combine with letters and symbols; the
  keyboard button switches to an input line you edit before sending. Herdr encodes each chord
  for the program's keyboard protocol; legacy protocols cannot distinguish every chord (for example Ctrl+I and Tab).
  Draft text in the input line is sent unchanged. Modifiers clear
  when leaving the pane or terminal view, or when the connection drops.
  **Settings → Terminal → Key bar → Edit key bar** opens a separate screen to add, remove and
  reorder every key, including modifier
  buttons. Register a custom combination such as Ctrl+W, choose editing keys or F1–F12, or restore
  the default row. Saved combinations use exactly their selected modifiers; ordinary keys use
  the currently held modifiers. Removing a held modifier button clears it.
- Dragging the terminal scrolls the real herdr pane.
- **Settings → Phone & devices → Keep screen on** keeps the screen awake while a terminal or chat
  pane is open. It is off by default, releases when the app is hidden, and resumes when
  you return. It needs HTTPS or localhost and browser support; power-saving mode may refuse it.

On a computer, install the app from `http://127.0.0.1:7317`. When the app runs on a PC you reach over SSH, tunnel to it first with `ssh -L 7317:127.0.0.1:7317 <this-pc>` and open that address on your own computer.

A plain HTTP LAN address also works in the browser, but it can't install the app or receive push.

The running server sends the alerts. Keep it running, and keep `HERDR_WEB_STATE_DIR` across restarts, since it holds the push key and device subscriptions.

## Remote PCs over SSH

A workspace row's **⋯** menu offers **New worktree** and **Open worktree…**, as herdr's own worktree keys do: the first checks a branch out as a git worktree under herdr's worktree folder and opens it as a workspace next to the repository's, the second lists the repository's other checkouts and opens one. New worktree opens with a branch (`worktree/brave-valley-07f8` style) and a name already filled in, as herdr's own form does; type over either. **Agent** picks what starts in the new checkout: the agent you last started, or Shell for none. In the By workspace view a worktree workspace sits under its repository's row. Its menu ends in **Delete worktree checkout…**, which deletes the folder and closes the workspace but keeps the branch; a checkout with unsaved changes is refused first, in git's words, with **Delete anyway** as the second step. Closing the repository's workspace closes its open worktree workspaces with it and leaves their checkouts on disk.

Open Settings → Remote PCs and choose **Add PC** (the command palette has it too), then enter an SSH alias or `user@host` for a Linux or macOS computer. The setup dialog walks you through the host fingerprint, the password or key passphrase, and an explicit install approval. The PC's workspaces then join the sidebar, and chat, files, terminal input and alerts all follow the PC you pick.

- **SSH runs on the server**, as the web server's account, with its OpenSSH configuration and agent. The browser never opens SSH itself.
- **The remote side gets a private runtime bundle** and a loopback-only bridge, reached through an SSH forward.
- **A herdr already running there** is never stopped or replaced.
- **Bridge updates:** when an app update needs a newer bridge, PCs that connect with their saved key are updated in the background.

More in [remote PCs](remote-pcs.md).

## Access and safety

Anyone who can reach the server can type into your terminals, so what matters is who gets in. It listens on `127.0.0.1` by default, which means only this computer. From anywhere else, a request gets in in one of three ways:

- **It is you, says Tailscale.** `tailscale serve` states the requesting device's Tailscale login in a header it strips from anything incoming. A login that matches this PC's own gets in; another login is refused, and a tagged device (one with no person's login) needs pairing. If you set `HERDR_WEB_TAILSCALE_SERVE_ONLY=1` to say `tailscale serve` is the only way in, and `tailscale status` on this PC lists one login on every node it sees and no tagged node, a serve request that states no login is the owner as well: no one else is among those nodes to be mistaken for (a node an ACL hides from this PC is not seen, and cannot reach serve either), so your own phone opens the address and lands in the app with no code. Nothing to set up, unless this PC's own Tailscale node is tagged: it then has no login of its own, so every device pairs, yours included, or you name your login in `HERDR_WEB_TAILSCALE_OWNER`.
- **It is a paired device.** **Settings → Phone & devices**, on the PC (or on a device already paired), shows a six-digit code that lives ten minutes and a QR code that carries it. On a headless PC, the `pair` command prints the same in its terminal (see [In a terminal](#in-a-terminal)); Devices also shows the pairing link as text, to send to the other device. The other device enters it once and keeps its own credential in an HttpOnly cookie; the list shows it, and **Revoke** immediately closes its terminal connections and roster stream and refuses subsequent requests.
- **It holds the token.** `HERDR_WEB_TOKEN`, for scripts and proxies, as a cookie after sign-in or as `Authorization: Bearer <token>`. When a token is set, everything else needs it, this computer and your own Tailscale login included: enter it once on each device, and that browser stays signed in for a year. A paired device still gets in without it.

| How you reach it | What gets you in |
| --- | --- |
| This computer only (default) | Nothing needed. With a token set, the token |
| SSH tunnel (`ssh -L 7317:127.0.0.1:7317 host`) | Nothing needed. With a token set, the token |
| `tailscale serve`, your own devices | Nothing needed: your login. With `HERDR_WEB_TAILSCALE_SERVE_ONLY=1` on a one-login tailnet, the owner's phone needs nothing either. With a token set, the token, once per device |
| `tailscale serve` on a tailnet you share with others | Your devices: your login (with a token set, the token once). Theirs: refused unless you pair them |
| Your LAN (`HOST=0.0.0.0` or a LAN address) | Pair each device, or set a token |
| A public domain or reverse proxy | Set a token, with HTTPS, and set the proxy up as in [Behind a reverse proxy](#behind-a-reverse-proxy). Never `tailscale funnel` it |

Until the first device is paired, and with no token set, a LAN or proxied address is open to anyone who reaches it, as it always was: the server warns on startup. The exception is a proxy on this PC while its Tailscale login is known, as with `tailscale serve`: a request that carries no login there needs pairing from the start, unless `HERDR_WEB_TAILSCALE_SERVE_ONLY=1` is set and that tailnet has one login and no tagged node, where such a request is the owner's own device. With that setting off, which is the default, every such request pairs. The first pairing closes access only after the browser returns its new device cookie. If the cookie is blocked or the pairing response is lost, the unconfirmed pairing does not restrict access; retry after checking browser and proxy cookie settings. Once confirmed, the gate stays closed: revoking every device does not reopen it. This app-level restriction also applies behind a proxy with its own authentication; other browsers need their own pairing or the app's token. Without a token, this computer itself stays in whatever happens, so you can never lock yourself out: revoke everything and pair again from `http://localhost:7317`. With a token set, this computer signs in with the token.

A token is a credential on the wire as much as a cookie is: on plain `http://`, anyone on the network path reads it, and then every keystroke after it. Reach this PC over Tailscale, put it behind a TLS-terminating proxy, or keep it on loopback and tunnel in; the server says so on startup when it is bound to another address over http.

The pairing code is a one-time secret: five wrong tries spend it.

### Behind a reverse proxy

**Set a token first** (`HERDR_WEB_TOKEN`). A proxy on this PC connects from this PC, so the server knows a proxied request only by what the proxy sends: an `X-Forwarded-For` header (or another forwarding header), or a `Host` that is not `localhost` or `127.0.0.1`. A proxy that sends neither makes every visitor count as this computer: they get in with nothing, and pairing a device does not close it. nginx's plain `proxy_pass` is such a proxy. With a token set, every visitor needs the token whatever the proxy sends.

The proxy has to do four things:

- keep the browser's `Host`, so the app's own requests are not refused as coming from another site (`invalid_origin`);
- send `X-Forwarded-For`, so a visitor is not taken for this computer;
- send `X-Forwarded-Proto: https` when it serves HTTPS, so cookies are marked Secure and the app's own requests are accepted;
- pass the WebSocket upgrade for `/ws`, which carries the terminal.

Caddy does all four by default, and gets the certificate itself:

```caddyfile
herdr.example.com {
	reverse_proxy 127.0.0.1:7317 {
		header_up -Tailscale-User-Login
	}
}
```

nginx does none of them by default:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name herdr.example.com;
    ssl_certificate     /etc/letsencrypt/live/herdr.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/herdr.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7317;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Tailscale-User-Login "";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }
}
```

The `map` block goes in the `http` section. `proxy_read_timeout` keeps an idle terminal connected, and `proxy_buffering off` lets the PC list update live.

Both examples drop a `Tailscale-User-Login` header a visitor sends. That header is how `tailscale serve` names your own login, and on a PC that runs Tailscale the server trusts it from any proxy on this PC, so a public proxy must not pass a visitor's copy on. With a token set the server asks for the token whatever that header says, so a proxy that does pass it on gives a visitor nothing.

**If the proxy already signs people in** (basic auth, Authelia, oauth2-proxy, Cloudflare Access and the like), let it hand the app the token, so nobody signs in twice and Settings stops warning that this address is open. Set `HERDR_WEB_TOKEN`, then have the proxy send it on every request it lets through, the terminal's `/ws` connection included. In Caddy, inside `reverse_proxy`:

```caddyfile
		header_up Authorization "Bearer {env.HERDR_WEB_TOKEN}"
```

In nginx, inside `location /`:

```nginx
        proxy_set_header Authorization "Bearer <your token>";
```

The proxy's own sign-in is then the only one: anyone it lets through gets in, and nobody needs to pair a device. Settings then offers no **Sign out**: the proxy would send the token again with the next request, so signing out is done at the proxy. Keep the app's port closed to everything but the proxy, as `HOST=127.0.0.1` does.

To check the app's gate, request its `/api/session` directly without a token: it must answer 401.
If the proxy signs people in, also check that a signed-out visitor cannot reach the app through
the public address.

**Sign out** in Settings → Devices clears, after asking once, this browser's token and device cookies; terminal sessions and agents keep running. It is shown when this browser signed in with the token or as a paired device, not when a proxy sends the token in the `Authorization` header (sign out at the proxy) or for automatic local or Tailscale access.

If `devices.json` under `HERDR_WEB_STATE_DIR` (default `~/.config/t-rex`) is corrupt or unreadable, the server keeps unrecognized external clients out and preserves the file. Local access and the owner's trusted Tailscale login without a configured token, and a valid token, still work. Settings → Phone & devices and the server log explain the error. Restore a valid registry from backup or fix its permissions, then restart; pairing and device changes remain disabled until it is repaired.

Nothing is typed without you:
- Input typed while disconnected waits as a draft for you to send or discard.
- On a current bridge, a message sent while the agent works goes to its next turn on its own, but only while the connection that sent it stays open and still holds the pane. Switching tabs or workspaces on the same PC keeps that pane attached until its automatic queue settles. Losing the connection or lease cancels delivery, even if the connection rejoins later. A reload or reconnect never resumes that: the saved copy of such a message comes back marked not confirmed, to copy or discard after checking the terminal. Other held messages stay with their PC and pane until you choose **Send now** or **Discard**. If the browser cannot save the queue, it says so: keep the tab open or copy the messages before reloading.
- A typed answer that picks an option of an approval, plan or menu waits for **Confirm**.

Attaches and reconnects wait when another client holds the terminal. **Open here** on the waiting
notice explicitly takes that pane with `--takeover`: the other web bridge waits in turn, while a
standalone `herdr terminal attach` exits. The herdr TUI stays connected (verified on herdr 0.9.3).
Observe connections cannot take a pane, and a displaced bridge never takes it back automatically.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` or a LAN address only with `HERDR_WEB_TOKEN` set or once a device is paired: until then that address is open to anyone who reaches it (see [Access and safety](#access-and-safety)). |
| `PORT` | `7317` | HTTP and WebSocket port. Left unset, the plugin takes the next of 17317, 27317, 37317 and 47317 when 7317 cannot be opened (another program has it, or Windows reserves it for Hyper-V, WSL2 or Docker), keeps that port for later starts, and the **T-Rex status** action prints the address. A port set here is never changed |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | herdr socket for API calls and terminal attach. For a named session, use `~/.config/herdr/sessions/<name>/herdr.sock`. A plugin install follows the socket of the herdr session that starts it; set `HERDR_SOCKET` in the plugin's config to pin another one, and that setting wins. |
| `HERDR_WEB_TOKEN` | unset | Shared token for scripts and proxies. Once set, every client that is not a paired device needs it, this computer and your own Tailscale login included |
| `HERDR_WEB_CSP` | unset (enforced) | `report-only` sends the policy as `Content-Security-Policy-Report-Only`: the browser reports what it would block and the app keeps working. Used to measure the policy after a change |
| `HERDR_WEB_TAILSCALE_OWNER` | this PC's Tailscale login | The Tailscale login that gets in through `tailscale serve` without pairing. Set it on a PC whose Tailscale node is tagged, which has no login of its own |
| `HERDR_WEB_TAILSCALE_SERVE_ONLY` | unset (off) | `1` declares `tailscale serve` the only way anything reaches this port. Then the owner's own device gets in through serve without a code, on a tailnet one login owns with no tagged node. Enable it only when no public reverse proxy, tunnel or other forwarding server exposes this port: a visitor through one would otherwise get the owner's access |
| `HERDR_WEB_STATE_DIR` | `~/.config/t-rex` | Push keys, device subscriptions, PC registrations and update builds |
| `HERDR_WEB_AUTO_UPDATE` | `0` | `1` installs new releases without asking |
| `HERDR_WEB_PUSH_SUBJECT` | this repository's URL | VAPID contact URL or `mailto:` address |
| `HERDR_WEB_BUNDLE_MANIFEST` | unset | Remote-PC bundle manifest (path or URL) that overrides local and published bundles |
| `HERDR_WEB_HERDR_BIN` | `herdr` | herdr executable used for terminal attach |
| `HERDR_WEB_APP_NAME` | unset (`herdr`) | The name the installed app has on a phone or computer, for example the PC's name. Each PC installs as an app of its own, and without it they are all called `herdr`. An app already installed takes the new name when the browser next updates it, usually within a day or two, without a reinstall. Keep it short: a home screen cuts a long label |
| `HERDR_WEB_PASTE_DIR` | `<pane cwd>/.t-rex` | Where pasted and attached files are saved: an absolute path or `~/…`. Set it to keep them out of your projects; an agent may then ask before reading one. It covers the panes of this server's PC; a remote PC keeps the default |
| `HERDR_WEB_MEDIA_ROOTS` | unset | Folders besides its own that a rendered HTML page may play a video or sound from, through a symlink beside it or a `../` link: absolute paths separated by `:` (`;` on Windows), for example a network share where recordings are kept. Any page can then find out which files exist there. Unset, a page plays its large videos only from its own folder, so a page that came with its own symlinks cannot find out which of this PC's files exist. A large video plays from an address made for that render: it works only from the device's network address that opened the page, for 30 minutes (reload the page after that), and stops when that device is revoked or signs out. The page's own script can read that address and share it, so for those 30 minutes anyone behind the same network address can play that file too |
| `CODEX_HOME` | `~/.codex` | Where Codex sessions are read |

## Updates

`bun run start` and the plugin look for a newer **release** 10 seconds after start and then every 5 minutes. A release is a `vX.Y.Z` tag ([changelog](../CHANGELOG.md)); commits between releases never reach installs. When a new version is out, a line under the header names it, and its **Update** button installs it and shows the install's steps; **Settings → Updates** has the same controls and the full error when an install fails. The release's notes are there too, under **What's new**: every release the update installs, newest first, as a short list of what is new, improved and fixed in the app's language, with **Show every change** opening that release's changelog, and the line's **What's new** button opens Settings on them. After the update and the reload, the line says which version now runs, with the same **What's new** button, until you close it; **Settings → Updates** keeps the notes under **What the last update brought**. To install releases without asking, set `HERDR_WEB_AUTO_UPDATE=1`.

An update is built and typechecked in a private checkout while the current server keeps serving. The new server must pass a health check, or the previous build comes back. herdr and your agents keep running, and a **Reload app** notice lets you save drafts before the new frontend loads.

After a herdr plugin reinstall, or a `git pull` and a build, in the checkout the app runs from, reloading the page cannot bring the update in: the server keeps running its old code. The page says so on its next status read, in place of the **Reload app** notice, and asks you to restart T-Rex on the PC. The notice goes away once it restarts:

```sh
herdr plugin action invoke alexanderkreidich.t-rex.stop    # plugin install
herdr plugin action invoke alexanderkreidich.t-rex.start
herdr plugin action invoke alexanderkreidich.t-rex.stop-windows    # on Windows
herdr plugin action invoke alexanderkreidich.t-rex.start-windows
```

From a checkout, stop `bun run start` and run it again.

Updates need a clean checkout: `main` for a source install, or herdr's plugin checkout. Local changes block an update, and they are never overwritten. More in [app updates](app-updates.md).

### Updating herdr

herdr itself is updated from **Settings → About → Update herdr**. herdr refuses `herdr update` typed into one of its panes ("run `herdr update` outside herdr"), and every terminal in the app is a pane, so the server runs it instead, for the herdr on the PC the app runs on:

- It installs the newest herdr and moves the running panes onto it with a live handoff. Panes and agents keep running, and open terminals reconnect.
- If a newer herdr was already installed from a shell, the running server is still the old one: Settings says so, and the button only moves the panes.
- What herdr printed is shown under the button. A herdr installed with Homebrew, mise or Nix is updated with that tool, and herdr's message names the command.

This is for Linux and macOS. On Windows, and for a remote PC, update herdr on that PC.

## Usage privacy

T-Rex does not collect or send installation, update or daily activity counts. The usage sender of the client it began from, its tracking ID, settings projection, API, controls and receiver have been removed. Existing `telemetry.json` files from older versions are not read or sent; they may be deleted manually. No opt-out environment variable is needed.

Optional integrations and the updater have separate network behavior. See [the source audit](security-audit.md) for destinations, credential access and remaining upstream trust boundaries.

## Keyboard shortcuts

`Mod` is **⌘** on Apple platforms and **Ctrl** elsewhere. Global app shortcuts add Shift, so the terminal keeps its own Ctrl keys, except `Mod+B` and `Mod+D`: off a Mac they take Ctrl+B and Ctrl+D (EOF) from the terminal, and Settings → Shortcuts can give them back. These are the defaults:

| Shortcut | Action |
| --- | --- |
| `Mod+Shift+K` | Command palette |
| `Mod+Shift+J` | Switch Chat / Terminal |
| `Mod+Shift+E` | Focus the current pane's message box, terminal input line or terminal |
| `Mod+Shift+PageUp` / `PageDown` | Scroll the current pane up / down, retaining one line |
| `Mod+B` | Toggle sidebar (`Mod+Shift+B` too) |
| `Mod+D` | Split the current pane right |
| `Mod+Shift+.` | Focus mode: each workspace's tabs as rows under it in the sidebar, no bar over the pane (a hidden sidebar hands the tabs back to the bar). Drag a row to reorder it, or among another workspace's rows to move the tab there with its shells and splits; the other rows make room as you drag, and a workspace whose last tab you move keeps a new shell |
| `Mod+Shift+O` | New workspace (`Mod+Shift+N` too, in the installed app: a Chrome tab keeps `Ctrl+Shift+N` for an incognito window) |
| `Mod+Shift+↑` / `↓` | Previous / next pane |
| `Mod+Shift+,` | Settings |

Selecting a pane or opening chat focuses its message box on desktop, while touch screens keep
focus where it was. **Mod+Shift+E** focuses the selected pane's input in any mode, including the
terminal's input line and direct input; it prefers masked input while a secret prompt is open. The
shortcut can be reassigned or disabled in Settings → Shortcuts.

**New tab** and **Split pane down** have no default key: pick one in
**Settings → Shortcuts**, and the command palette shows it beside the action.

**Settings → Shortcuts** changes each app binding or turns it off: press **Record** on a row,
then the new chord (Escape cancels). A Mod+Shift chord is always safe for the terminal. Other
chords are kept exactly as pressed, such as `⌘+PageUp` or `Ctrl+K`, and need Ctrl, Alt or (on a
Mac) ⌘. Letters, digits, the punctuation keys, arrows, PageUp/PageDown and Home/End can be bound. A
punctuation key is read by where it sits, so on a Hungarian keyboard É is the key US labels `;`, and
the binding works on any layout; the row shows your keyboard's own character where the browser says it. A chord the browser, the OS or text editing keeps (`Mod+W`/`T`/`N`, `⌘+Q`, `Mod+C`/`V`/`X`/`A`/`Z`,
`Ctrl+PageUp`/`PageDown`, macOS `Ctrl+arrows`), an unbindable key or an already-assigned chord is
refused on the row. Plain Ctrl or Alt chords are shells', editors' and agents' keys (`Ctrl+R`,
`Ctrl+A`/`E`, Alt word moves): the row says so and saves one only after **Save anyway**, and from
then on that key no longer reaches the pane. A ⌘ chord the browser commonly uses (such as `⌘+S`,
`⌘+L` or `⌘+⌥+I`) asks the same way. The row's list still picks a Mod+Shift letter, digit,
arrow or PageUp/PageDown without a keyboard; Home, End and the punctuation keys are bound with Record. A search field filters the list. Settings
are saved in this browser, not on the remote PC. The command palette shows the current bindings
and omits disabled ones. Reset shortcuts restores the defaults.

Known browser/OS reservations are marked, but other combinations can also be intercepted by
your browser, OS or extensions. Installed-app mode may behave differently. While an IME is
composing, keys stay with it. In a text field with text, a binding on an arrow, Home or End keeps
its text-selection behavior; from an empty one, such as the chat's empty message box, they switch panes.
List and tab controls also have focus-local keys; those do not become global terminal shortcuts.
On a focused tab, Alt+Shift+Left/Right reorders it and Shift+F10 opens its menu; in focus mode a
focused tab row moves with Alt+Up/Down, as a workspace row does. For the pane menu
on desktop, tab to the pane header's **⋯** (it appears on keyboard focus) and press Enter.
Shift+F10 inside the terminal stays with the terminal program.

On a phone, use the header, the tab's ⋯ and the More menu for app actions. The command palette
and its plugin actions are not available in the phone touch UI. Use a wider screen or an external
keyboard's `Mod+Shift+K` shortcut (or your configured binding).
The terminal key bar is configured separately under **Settings → Terminal**.
An external keyboard uses the same app bindings as a desktop.

Plain PageUp/PageDown scroll the chat transcript, even while its message box is focused;
the draft, caret, selection and focus stay intact. Modified page keys, composition,
other editable controls and modal input retain their own behavior. Plain terminal page keys
continue to belong to the running program.

Paging shortcuts work while the message box is focused, preserving the draft, caret and selection.
Chat scrolls its transcript immediately; Terminal scrolls herdr's shared history, so other
clients see the same terminal position. When herdr explicitly reports zero native history,
the shortcut instead sends plain PageUp/PageDown to the running application through its live
input lease. That application owns its page length.
Unavailable or invalid history data never causes application input, and no key is queued
while disconnected.
One line stays visible between pages. Chat uses the displayed text's line height, and Terminal
uses native rows. A page still advances by at least one pixel in chat or one terminal row.
For an iPad with an external keyboard that lacks PageUp/PageDown, assign letters such as
U and D to **Scroll pane up** and **Scroll pane down** in Settings → Shortcuts (Mod+Shift+U/D,
or record a chord such as `⌘+U`). This lets you read history without leaving the message box or reaching for
the screen. Shift+PageUp/PageDown alone retains the focused control's own behavior.

Enter sends and Shift+Enter adds a line. On a touch screen, Settings → Chat → Composer → Return inserts a new line lets Return add a line instead; use Send to send the message. On a desktop, turning off Enter sends switches sending to Mod+Enter. On a touch screen with a hardware keyboard, Mod+Enter sends while Return inserts a new line is on. This choice is saved per device.

## How it works

```mermaid
flowchart LR
  subgraph devices [Your devices]
    B[Browser / phone app]
  end
  subgraph pc [This PC]
    S[T-Rex<br/>Bun server]
    H[(herdr server)]
    A[Agents in herdr panes<br/>Claude Code, Codex, …]
    T[(Agent session files)]
  end
  subgraph remote [Other PCs]
    R[Private bridge + herdr]
  end
  B <-- HTTP / WebSocket --> S
  S <-- socket API and terminal attach --> H
  H --- A
  A -. writes .-> T
  S -. reads .-> T
  S <-- SSH forward --> R
```

A React client talks to a Bun HTTP/WebSocket server.

- **Status:** the server reads workspaces and agent status from herdr's Unix socket.
- **Terminal:** the real `herdr terminal attach` runs on a Node PTY sidecar and draws the pane's screen on the bridge. Browsers watching one pane share one attach, and each is kept in step with that screen by its differences, with local echo on a slow link ([State Synchronization Protocol](ssp.md)).
- **Chat:** it reads the agents' own session files, and sending types into the same live pane.

herdr owns the processes and the scrollback.

## FAQ

<details>
<summary><b>Does it replace herdr's own TUI?</b></summary>

No. Both attach to the same terminals at the same time. Use the TUI at your desk and the web app anywhere else. Nothing needs to be stopped or handed over.
</details>

<details>
<summary><b>Do I need Tailscale?</b></summary>

No, but a phone needs two things Tailscale gives at once: a way to reach the PC from outside your network, and HTTPS, which installing the app and push alerts both require. Without it:

- **An SSH tunnel from the phone** (Termux, Blink): `ssh -L 7317:127.0.0.1:7317 <pc>`, then open `http://localhost:7317` on the phone. Browsers treat localhost as secure, so installing and alerts should work while the tunnel is up (not verified on iOS yet). The phone still has to reach the PC over SSH.
- **A VPN into your home** (WireGuard, ZeroTier, a router VPN): the LAN address works in the browser, but a plain `http://` address can neither install the app nor receive alerts.
- **A reverse proxy with a real certificate** on a domain you own, with a token set and the proxy sending `X-Forwarded-For`: [Behind a reverse proxy](#behind-a-reverse-proxy) has Caddy and nginx examples to copy. This exposes the server to the internet, so read [Access and safety](#access-and-safety) first.
</details>

<details>
<summary><b>Does my code or conversation leave my machine?</b></summary>

Session files stay on the PC running each agent, and their contents are sent to browsers connected to the app. T-Rex has no hosted relay or account service of its own. The agents' own connections to model providers depend on their configuration.

Optional features can send data off the PC:
- Updates and remote-PC setup fetch releases or configured runtime bundles over the network; remote panes are reached over SSH.
- Enabled push alerts go through the browser vendor's push service as encrypted notifications.

See [Access and safety](#access-and-safety) for who can connect to the app.
</details>

<details>
<summary><b>An agent is missing from the chat, or shows only terminal text.</b></summary>

The chat needs the agent's own session file. Check that the agent runs in a herdr pane on this PC (or on an added PC) and has already written its first message. Agents without a native reader always get the terminal-text view, and the Terminal view always works.
</details>

<details>
<summary><b>The colors look too dark, or the light theme looks dark, in Samsung Internet.</b></summary>

Samsung Internet has a forced dark mode that repaints every page, including one that brings its own light and dark themes, as this app does. A light theme comes out dark, and a dark one is darkened a second time: similar shades run together, and the bars of the plan meters can look empty. Turn off **Force dark mode for web content** (**웹 콘텐츠에 어두운 화면 모드 강제 적용**) in Samsung Internet's settings, or open the app in Chrome. Reported on a Galaxy Tab S7+ ([#451](https://github.com/alexanderkreidich/t-rex/issues/451)).
</details>

<details>
<summary><b>How is this different from collie, roamgate or herdr-remote?</b></summary>

All three are in the herdr plugin marketplace too, and each does something this app does not. [collie](https://github.com/AltanS/collie) is a mobile terminal for herdr, tmux and zellij, with a status dashboard, a key pad, quick replies and voice input, served over Tailscale by its own bridge. [roamgate](https://github.com/powerfooI/roamgate) is a browser client for herdr with a file explorer and diff annotations, installed by its own script. [herdr-remote](https://github.com/dcolinmorgan/herdr-remote) is a macOS menu-bar app with a phone dashboard and a Telegram bot behind a relay and a free tunnel.

T-Rex reads the agent's own transcript, so Claude Code, Codex, omp, omo, gjc, pi, OpenCode and identifiable Devin CLI panes are a chat with the work folded per turn. Supported prompt cards are checked against the live menu before an answer is typed; Devin prompts use Terminal. The terminal is the same live pane as your TUI, other PCs join over SSH from the sidebar, and it installs and updates as a herdr plugin, with no server or account of its own. It brings no tunnel: you reach it over Tailscale, SSH or your own HTTPS proxy. If you want tmux or zellij, diffs, Telegram or a tunnel out of the box, one of the others is the better fit.
</details>

<details>
<summary><b>How is this different from Happy, Paseo or CloudCLI UI?</b></summary>

Those projects start and manage agents through their own wrapper, daemon or server, and bring their own apps. T-Rex adds nothing between you and the agent. It is a window onto the herdr sessions you already run, so the same pane is live in your terminal, your browser and your phone at once. If you don't use herdr, one of those is the better fit.
</details>
