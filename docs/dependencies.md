# Dependencies

| Dependency | Package | Why | On a stock Omarchy 4.5? |
|---|---|---|---|
| Omarchy shell | `omarchy` 4.5 | Hosts the plugin (Quickshell 0.3, Qt 6.12) | yes |
| Deno ≥ 2 | `deno` | Runs the helper: TCP JSON-RPC to snapserver, cover art, snapclient supervision | not guaranteed: `sudo pacman -S deno` |
| snapclient | AUR `snapcast` (0.35) | Local playback only | no: `omarchy pkg aur add snapcast` |
| libsecret | `libsecret` (`secret-tool`) | Server password, only for servers with authentication | yes |

The helper has **no third-party code**: it uses only Deno's built-in APIs and runs with
`--no-remote --no-npm`, so nothing is downloaded at install or run time. The tests need nothing
beyond Deno and Qt's `qmltestrunner`.

## Why a helper process

QML in Quickshell has no TCP or WebSocket client (QtWebSockets is not installed on Omarchy), so the
JSON-RPC connection lives in a separate process. The same process supervises snapclient, which
keeps child processes and their permissions out of the shell.

## Installing snapclient

`omarchy pkg aur add snapcast` installs both snapclient and snapserver. The package ships systemd
units; leave `snapclient.service` disabled, or this computer shows up twice on the server (once
from the unit, once from the plugin).
