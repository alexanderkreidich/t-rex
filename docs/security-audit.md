# Privacy and trust-boundary audit

Source review: 2026-10-21, initially based on `feat/sidebar-toggle-remote-pcs`.
The removal was then ported to `refactor/remove-usage-telemetry`, based on `main` at `ff7dc4b`,
preserving the newer SSP and predictive-echo implementation.

## Scope and limits

Reviewed the browser client, Bun bridge, shared contracts, updater, SSH setup, native wrappers,
installers and CI configuration for outbound connections, credential access and privileged behavior.
This is a source audit, not a dependency/binary audit, traffic capture or a guarantee that no
vulnerability exists. No real user credential files were opened and no external integration was
activated. Examples and test credentials are not production credentials.

No hardcoded maintainer login, universal password, private key, or separate covert upload of
terminal contents was identified in the reviewed first-party code. The terminal application itself
runs with the server user's permissions: a person allowed to drive a terminal can execute commands
and read that user's files. Do not treat web authentication as an OS sandbox.

## Removed: usage collection

The former default-on sender posted to
`https://herdr-web-ui-telemetry.devswha.workers.dev/v1/events` and `/v1/active`.
It sent a persistent random installation ID, version/previous version, OS, architecture, install
method, an allowlisted settings snapshot, and daily active agent kinds. The receiver recorded a
country code. A notice becoming visible acknowledged it automatically; it did not require an
explicit opt-in. Sending waited ten minutes after that acknowledgement. The permanent ID made
messages from the same installation linkable even without names or IP addresses in the database.

Removed the sender and its timers/state handling, daily visit hooks, browser settings projection,
API, notice, settings controls, translations, schema, Cloudflare Worker/database definition,
report/deployment tools and obsolete feature tests. Release checks no longer require deploying the
collector. The removed API returns the normal not-found response. New privacy regression tests
check the absence of these shipping components and hooks.

An older installation's `telemetry.json` is left untouched on disk and is no longer read. Removing
code does not delete records previously received by the collector's operator. Already-running older
processes/builds, installed older plugins and remote bridge bundles are not patched by a source
edit; rebuild and restart the instance that should use this tree.

## Remaining findings, highest priority first

### 1. An exposed fresh installation can grant terminal access without authentication

`server/index.ts` defaults to loopback and an empty `HERDR_WEB_TOKEN`.
`server/access.ts:decideAccess` grants `via: "open"` when there is no configured token, no confirmed
pairing gate and no Funnel header, subject to the earlier proxy/Tailscale checks. Binding to a LAN
or public interface therefore does not itself require authentication. A reverse proxy that hides
all forwarding evidence can also resemble a trusted local client.

This is explicit compatibility behavior, not a secret maintainer credential. It is nevertheless a
high-impact deployment risk: access means terminal control. Keep loopback binding or configure a
strong token and TLS/Tailscale before exposing the server. The source already warns about this;
this change does not alter authorization policy.

Evidence: `server/index.ts:createServer`, `server/access.ts:decideAccess`,
`server/access.ts:cameThroughProxy`, `server/auth.ts`.

### 2. Executable code comes from Git tags and release assets without signatures

- Managed starts check Git tags after ten seconds and every five minutes. Checks use the
  checkout's `origin`. `HERDR_WEB_AUTO_UPDATE=1` enables automatic
  installation; otherwise checks offer updates. Dirty or non-main source checkouts are blocked.
  Installation checks out the selected revision, runs `bun install`, typecheck and build, then
  activates it. There is no independent signed-release verification in this path.
- The default remote bundle manifest is under
  `github.com/alexanderkreidich/t-rex/releases/download/remote-vN/manifest.json`. SSH setup downloads
  and executes its bridge/runtime. Asset SHA-256 checks detect corruption but the checksum and
  download URL come from that same manifest; this is not independent publisher authentication.
  A local manifest/build or `HERDR_WEB_BUNDLE_MANIFEST` can override this source.
- Registered remote bridges can update unattended when `auto_update_bridges` is enabled (the default) and the
  bridge is eligible for management. Initial installation/SSH approval is a separate user flow.

This is the main remaining trust boundary: before distributing builds, choose an explicit
update/signature policy.

Evidence: `server/updater.ts:start`, `server/updater.ts:discover`, `server/updater.ts:request`,
`server/supervisor.ts`, `server/remote-bundle.ts`, `server/machines.ts:lost`, `herdr-plugin.toml`.

### 3. SSH setup deliberately creates persistent access to registered hosts

The Add PC flow can use existing SSH keys/ssh-agent and explicit password/host-key challenges.
After approval it generates a dedicated, passphrase-less Ed25519 key and appends its public key to
the target account's `authorized_keys`. Restrictions disable agent forwarding, X11 forwarding and
PTY allocation, but do not impose a forced command; this is still powerful remote account access.
The key is generated locally, not a hardcoded maintainer key. Connections can reconnect and manage
approved remote bridge installations without asking for the original password again.

Evidence: `server/machines.ts:prepare`, `server/remote-host.ts:authorizeKey`, `server/ssh.ts`.

### 4. Web Push sends encrypted notifications through the browser vendor

- Web Push: subscribed devices receive encrypted notification payloads via their browser's push
  endpoint. Titles can include pane/workspace or machine context. The repository URL in the
  VAPID subject is contact metadata, not an analytics destination. Keys/subscriptions persist on
  the server. Push providers can observe delivery metadata, but the application encrypts payloads.

Evidence: `server/push.ts:deliver`.

### 5. Browser clipboard writes and local diagnostics are automatic

`Clipboard from a pane` defaults to on. OSC 52 output from any pane process can write text to the
browser clipboard, subject to browser permissions. Clipboard queries are ignored: this path is
not a clipboard reader. Disable the setting if terminal processes should not replace copied text.

Connection incidents/page lifecycle events can POST a bounded metadata breadcrumb trail to this
instance's own `/api/connection-diagnostics`; the server logs it locally. The diagnostic ID is
per connection-trace object, not the removed persistent installation ID. There is no forwarding
to the maintainer in this path. This audit leaves local operational diagnostics intact.

Evidence: `src/components/PaneTerminal.tsx` (OSC 52 handler), `src/lib/connectionTrace.ts`,
`server/client-connection-log.ts`.

## Verification of the removal

- `bun run typecheck` and the production build pass; generated types/themes are fresh.
- Focused privacy, settings, API-client, release-guard, convention and core-ownership tests:
  89 passed. The HTTP/WS contract suite passed all 122 tests in the isolated integration lane,
  including GET/POST of the removed `/api/telemetry` returning 404.
- `minimal-ui-regression.ts` passes with the system Chrome. Desktop (1440x900) and mobile
  (390x844) sandbox screenshots were inspected. The sandbox was stopped afterward.
- The initial `check fast` was not green: 2711 passed, 3 failed, 22 skipped. Failures were in
  `scripts/install-star.test.ts` (expected browser-help text), `scripts/plugin.test.ts`
  (fixture config/port lookup) and `server/portal.test.ts` (relay-start timeout). Those test
  implementations and their installer/plugin/Portal implementations were not changed here.
  Portal passes when rerun with the convention tests outside the full parallel suite.
  After porting to current main, `check fast` reports 2761 passed, 3 failed, 22 skipped in the
  same three files. A separate, unmodified checkout of main reproduces the installer and Portal
  failures (2828 passed, 2 failed, 22 skipped); the plugin case passes in that baseline run\n  and all 21 plugin tests pass when rerun separately on the PR branch (one platform skip).
- The initial full integration attempt exceeded the command's 120-second time limit and also\n  recorded an attach-time terminal-query failure. A fresh full integration run after porting to\n  current main reproduces that attach-time query failure; its HTTP/WS contract file still\n  passes all 122 tests. Neither full run is reported as green. No unrelated test assertions\n  were weakened to obtain a green result.

## Recommended follow-up order

1. Publish the owned remote-bundle and update channels (`remote-v1000`, the first `v*` release);
   choose whether periodic update checks and remote auto-updates should exist at all.
2. Require explicit authentication before non-loopback exposure instead of relying on a warning.
3. Plan meters with their Keychain discovery, the Hub, voice input and Portal are removed; decide
   whether Web Push stays, and remove what does not in its own slice rather than hiding controls.
4. Consider independent release signatures.
