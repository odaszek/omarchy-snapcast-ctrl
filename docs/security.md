# Security model

Status: design notes written during implementation. The full security review (Phase 5) happens
once all functionality is confirmed working.

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
     server only by default), caps it at 4 MiB, checks magic bytes (PNG/JPEG/GIF/WebP/BMP), and
     stores it under `~/.local/state/omarchy/snapcast-ctrl/art/` (0600). `Service.qml` accepts
     only paths inside that directory.
2. **The shell (trusted) → helper.** Requests are validated in the helper: ids, enumerated
   commands/properties, numeric ranges; stream URIs are rebuilt from fields with strict patterns
   and percent-encoding (`process://` is not offered: it runs a program on the server).
3. **Helper process permissions** (`helper/start.sh`): `env -i`; read: its code and state dir;
   write: state dir; net: only `host:control,host:http` (or all hosts when the user picks cover
   art "From anywhere"); run: the resolved `snapclient` and `secret-tool` binaries only; env:
   `HOME`, `XDG_RUNTIME_DIR`; sys: hostname. No remote code (`--no-remote --no-npm`), no
   third-party dependencies.
4. **snapclient**: started with an argv array (never a shell), every argument validated
   (`Model.snapclientArgs`), with a cleared environment except `HOME`/`XDG_RUNTIME_DIR`/`PATH`.
5. **Credentials**: the optional server password lives in the Secret Service keyring, never in
   `shell.json`, the log or the process list. snapclient is not given credentials (they would
   appear in its command line), so local playback does not work with servers that require
   authentication on the streaming port.

## Known limitations

- Snapcast's TCP control protocol is plaintext; on an untrusted network anyone on the path can see
  and change what the plugin sees. Use it on a trusted LAN (or a VPN such as Tailscale).
- Snapserver authentication (`Server.Authenticate`) sends the password in Basic form over that
  plaintext connection.
- Images are decoded by Qt's image plugins inside the shell process.
