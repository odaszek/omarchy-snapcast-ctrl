# Troubleshooting

- **Log**: `~/.local/state/omarchy/snapcast-ctrl/logs/helper.log` (connection errors, snapclient
  output with `--verbose`). The panel's footer shows the last warning for 30 seconds.
- **"Can't reach the Snapcast server"**: check the host and the *control* port (default 1705,
  `[tcp-control]` in `/etc/snapserver.conf`; older servers call the section `[tcp]`). Test with
  `printf '{"id":1,"jsonrpc":"2.0","method":"Server.GetRPCVersion"}\n' | nc HOST 1705`.
- **"authentication required"**: the server has `[server] auth` enabled; enter a user name and
  password in Settings (stored in the keyring under `service=omarchy-snapcast-ctrl`).
- **No cover art**: the default policy loads art only from snapserver's own HTTP port (1780).
  Spotify/TuneIn artwork lives on other hosts; choose "Server + internet" in Settings if you accept that
  those hosts see what is playing.
- **Local playback does nothing**: install snapclient (`omarchy pkg aur add snapcast`), make sure the
  streaming port (1704) is reachable, and try the "PipeWire / Pulse" backend. The client appears on
  the server as `omarchy-<hostname>` (or the id set in Settings).
- **Changes to the plugin code don't show up**: the shell keeps the service loaded and caches QML;
  `scripts/install.sh` restarts the shell (`omarchy restart shell`).
- **Two copies of this computer on the server**: disable the system `snapclient.service`.
