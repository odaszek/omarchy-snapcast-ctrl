# Testing

## Automated

```bash
scripts/test.sh                       # everything below, ~10 s
cd helper && deno task test           # Deno tests only
cd helper && deno test --allow-all ../tests/integration.test.ts --filter "local playback"
```

| Suite | What it covers |
|---|---|
| `tests/model.test.ts` | normalization and bounds, the notification reducer (every method, unknown ids, both `Stream.OnProperties` shapes), group-volume math, stream URI builder incl. injection attempts, settings, `--allow-net` list, snapclient argv, soundcard parsing, `neutralize` |
| `tests/rpc.test.ts` | NDJSON framing (split/CRLF/UTF-8/oversized lines), requests, batches, notifications, timeouts, reconnect, hostile server input, auth in `onConnected` |
| `tests/art.test.ts` | cover-art URL policy, image sniffing, size limit, cache |
| `tests/integration.test.ts` | the real helper via `start.sh` (real permissions) against `tests/tools/mock_snapserver.ts`: every operation end to end, notifications from other controllers, server restart, auth failure, local playback with a fake snapclient (argv, crash/restart, stop, cleanup on EOF), `--allow-net` enforcement, unconfigured state |
| `tests/qml_static.test.ts` | every QML text sink is `PlainText`, no remote URLs, no `openUrlExternally`, translation keys exist, manifest defaults match the model |
| `tests/qml/tst_plaintext.qml` | `qmltestrunner`: markup-shaped strings render literally; `neutralize` defeats `Text.AutoText` |
| `tests/live.test.ts` | opt-in, against a real server: `SNAPCAST_LIVE=host[:port]` (read-only), `SNAPCAST_LIVE_WRITE=1` (adds/removes a test stream, toggles a group's mute and restores it) |

## Manual UI work

```bash
deno run --allow-net --allow-read tests/tools/mock_snapserver.ts 17050 17800   # fake server
# Settings → host 127.0.0.1, control 17050, HTTP 17800
scripts/install.sh            # copy into ~/.config/omarchy/plugins and restart the shell
omarchy-shell shell summon odach.snapcast-ctrl
```

Panel keys: `g` group settings, `t` streams, `n` add stream, `s` settings, `p` play here on/off,
`m` mute, `←/→` volume, `↑/↓` scroll, `r` reconnect, `Esc` back/close.

## SnapWeb parity checklist (run against a real server, side by side with `http://<server>:1780`)

- [ ] Connects; groups shown as cards; offline clients dimmed; "Hide offline" hides them and empty groups
- [ ] Client volume slider and mute; changes appear in SnapWeb and vice versa
- [ ] Group volume slider (groups with > 1 client) scales clients proportionally; group mute
- [ ] Stream selector per group
- [ ] Previous / play-pause / next for controllable streams (librespot, MPD with control script)
- [ ] Now playing: title, artist, album, cover art (server cache; "From anywhere" for Spotify art)
- [ ] Group settings: stream, client checkboxes (moving clients between groups), name
- [ ] Client details: name, latency (applied live, Cancel restores), MAC/ID/IP/host/OS/version
- [ ] Delete an offline client (with confirmation)
- [ ] Streams page: list, remove (confirmation), add pipe/tcp/alsa/meta streams
- [ ] Shuffle / repeat / seek where the stream supports them
- [ ] Settings: server host/ports, user + password (auth-enabled server)
- [ ] Play on this computer: starts snapclient, client appears as "this computer", audio in sync with another client; stop; survives a server restart
- [ ] Bar: icon reflects connection/playback, scroll changes the target group's volume, middle-click toggles local playback, tooltip
- [ ] Theme switch (`omarchy theme set …`) restyles the panel; top and bottom bar positions; left/center/right sections
