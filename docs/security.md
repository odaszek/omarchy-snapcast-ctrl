# Security model

Status: reviewed 2026-11-15 (whole tree: helper, `lib/model.mjs`, QML, scripts). Findings and what
was done about them are listed under "Review results"; what remains is under "Known limitations".

## Trust boundaries

1. **Snapcast server (untrusted input).** Everything it sends — names, stream ids, URIs, metadata,
   art URLs — is attacker-controllable by anyone who can reach the server's control port (it is
   unauthenticated by default on the LAN).
   - The helper normalizes every payload (`lib/model.mjs normalize*`): fixed shape, strings capped
     and stripped of control and bidi-override characters, collections capped (128 groups, 256
     clients, 128 streams), duplicate ids dropped. Lines over 4 MiB are dropped.
   - QML renders every string with `PlainText` (`Text.PlainText`); strings passed to Omarchy
     components that might use `AutoText` go through `Model.neutralize`. Static and
     `qmltestrunner` tests enforce both.
   - Cover art is never loaded by the shell from the network. The helper fetches it (policy:
     server only by default), caps it at 4 MiB, checks magic bytes (PNG/JPEG/GIF/WebP), follows
     at most 3 redirects with the policy re-checked on every hop, and
     stores it under `~/.local/state/omarchy/snapcast-ctrl/art/` (0600). `Service.qml` accepts
     only paths inside that directory.
2. **The shell (trusted) → helper.** Requests are validated in the helper: ids, enumerated
   commands/properties, numeric ranges; stream URIs are rebuilt from fields with strict patterns
   and percent-encoding (`process://` is not offered: it runs a program on the server).
3. **Helper process permissions** (`helper/start.sh`): `env -i`; read: its code and state dir;
   write: state dir; net: only `host:control,host:http` (or all hosts when the user picks cover
   art "Server + internet"); run: the resolved `snapclient` and `secret-tool` binaries only; env:
   `HOME`, `XDG_RUNTIME_DIR`; sys: hostname. No remote code (`--no-remote --no-npm`), no
   third-party dependencies.
4. **snapclient**: started with an argv array (never a shell), every argument validated
   (`Model.snapclientArgs`), with a cleared environment except `HOME`/`XDG_RUNTIME_DIR`/`PATH`.
5. **Credentials**: the optional server password lives in the Secret Service keyring, never in
   `shell.json`, the log or the process list. snapclient is not given credentials (they would
   appear in its command line), so local playback does not work with servers that require
   authentication on the streaming port.

## Review results

Fixed in this review:

- **Cover art "Server + internet" could be aimed at local services (SSRF).** A hostile server (or
  anyone able to set stream metadata) could make the helper send GET requests to `127.0.0.1`,
  the router or other LAN hosts, directly or through a redirect. Loopback, private, link-local,
  CGNAT, non-global IPv6, `localhost`, `.local`/`.internal` and single-label hosts are now refused
  unless they are the configured server's HTTP port, and redirects are followed by hand with the
  same check per hop (`helper/art.ts isPrivateHost`, `ArtCache.allow`).
- **BMP art dropped.** Its two-byte signature was too weak to say what Qt would decode.
- **snapclient option values could start with `-`.** A sound card or client id such as `--player`
  from `shell.json` would have been read as an option. Both patterns now require a non-dash first
  character (`Model.snapclientArgs`).
- **Server text reached Omarchy components un-neutralized** (stream ids in dropdowns, client names
  in toggles and confirmation dialogs). Not exploitable with the current shell, whose components
  use plain text, but the defence is now applied and enforced by `tests/qml_static.test.ts`.
- **Orphaned snapclient.** Overlapping start/stop calls could leave an untracked snapclient
  running after the helper exits; start/stop are now serialized.
- **Password lost on leaving Settings** (held by a page-owned timer). It is now queued in the
  service, in memory only, until the helper for the new host/user is up.

Checked and found sound: no shell interpolation anywhere (argv arrays only); helper permissions
match `start.sh` and the network restriction is covered by an integration test; stream URIs can't
smuggle parameters; ids, commands and ranges are validated before reaching the server; log lines
can't be forged and contain no credentials; state files are 0600 under a 0700 directory; no
secrets or private addresses are committed; no third-party code is loaded.

## Known limitations

- With cover art "Server + internet", a public host name that resolves to a private address (DNS
  rebinding) is not caught: the check is on the name, not the resolved address. The response is
  only ever used if it is a small image, so the exposure is a blind GET. Keep "Server only" on
  networks you don't trust.
- If the helper is killed with SIGKILL (not a normal shell exit or crash, which close its stdin),
  snapclient keeps running until it is stopped by hand (`pkill -f "snapclient --hostID omarchy-"`).
- Adding librespot/AirPlay streams names a program path on the server. That is what the Snapcast
  API offers to anyone who can reach the control port; the plugin adds no privilege, and
  `process://` stays unavailable in the form.
- Snapcast's TCP control protocol is plaintext; on an untrusted network anyone on the path can see
  and change what the plugin sees. Use it on a trusted LAN (or a VPN such as Tailscale).
- Snapserver authentication (`Server.Authenticate`) sends the password in Basic form over that
  plaintext connection.
- Images are decoded by Qt's image plugins inside the shell process.
