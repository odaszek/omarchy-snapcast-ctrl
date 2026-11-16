# Helper protocol

`Service.qml` runs the helper as `bash helper/start.sh STATE_DIR NET_ALLOW SNAPCLIENT [args]` and talks
newline-delimited JSON over its stdin/stdout. The helper talks JSON-RPC 2.0 to snapserver over TCP
(port 1705, also newline-delimited).

Helper arguments: `--state-dir DIR --host H --port 1705 --http-port 1780 --stream-port 1704
--art server|any|off [--username U] [--snapclient BIN] [--verbose]`.

## Requests (shell → helper)

`{"id": <number>, "op": "<op>", ...params}` → `{"id": n, "ok": true, "result": {...}}` or
`{"id": n, "ok": false, "error": "..."}`. Request lines are capped at 256 KiB.

| op | params | Snapcast call |
|---|---|---|
| `ping` | – | – |
| `status` | – | returns the current snapshot |
| `reconnect` | – | drops and reopens the connection |
| `refresh` | – | `Server.GetStatus` |
| `setClientVolume` | `clientId`, `percent?`, `muted?` | `Client.SetVolume` (coalesced per client) |
| `setVolumes` | `volumes: [{id, percent}]` | `Client.SetVolume` per client (group volume) |
| `setClientName` | `clientId`, `name` | `Client.SetName` |
| `setClientLatency` | `clientId`, `latency` | `Client.SetLatency` |
| `deleteClient` | `clientId` | `Server.DeleteClient` |
| `setGroupMute` | `groupId`, `mute` | `Group.SetMute` |
| `setGroupName` | `groupId`, `name` | `Group.SetName` |
| `setGroupStream` | `groupId`, `streamId` | `Group.SetStream` |
| `setGroupClients` | `groupId`, `clients: [id]` | `Group.SetClients` |
| `streamControl` | `streamId`, `command`, `params?` | `Stream.Control` (`play pause playPause stop next previous seek setPosition`) |
| `streamSetProperty` | `streamId`, `property`, `value` | `Stream.SetProperty` (`loopStatus shuffle mute volume rate`) |
| `addStream` | `spec: {type, name, path, …}` | `Stream.AddStream`; the URI is built by `Model.buildStreamUri` → `{added, streamId}` or `{added: false, field, error}` |
| `removeStream` | `streamId` | `Stream.RemoveStream` |
| `localStatus` | – | probes `snapclient --version` |
| `localStart` | `player`, `soundcard`, `latency`, `hostId` | starts/updates the supervised snapclient |
| `localStop` | – | stops it |
| `localClientId` | `hostId` | the client id local playback uses |
| `listSoundcards` | `player` | `snapclient --player P --list` |
| `hasPassword` / `setPassword` | `password` (empty removes), `target` `{host, port, username}` it was typed for (refused unless it matches the helper's settings) | keyring via `secret-tool`, keyed by host, port and user |

Snapserver does not echo notifications to the session that caused a change, so the helper applies
each successful response to its snapshot itself (and optimistically, for volume, mute and stream).

## Events (helper → shell)

| event | fields |
|---|---|
| `ready` | `version`, `host` |
| `connection` | `state` (`connecting connected disconnected idle unconfigured`), `error`, `host`, `port`, `rpcVersion`, `serverVersion` |
| `status` | `server`: normalized snapshot (`lib/model.mjs` `normalizeServer`) plus `artFile` per stream (a cached image path or `""`), throttled to one per 40 ms |
| `local` | `state` (`unavailable stopped starting running restarting error`), `available`, `version`, `clientId`, `error`, `binary` |
| `log` | `level` (`warn`/`error`), `message` |
| `fatal` | `error` (Deno missing, second instance) |
