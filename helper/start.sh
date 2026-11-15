#!/usr/bin/env bash
# Start the SnapcastCtrl helper with an explicit permission set and a minimal
# environment. Used by Service.qml and by the integration tests.
#
#   start.sh STATE_DIR NET_ALLOW SNAPCLIENT [helper args...]
#
#   STATE_DIR   ~/.local/state/omarchy/snapcast-ctrl (log, art cache, lock)
#   NET_ALLOW   Deno --allow-net list: "host:1705,host:1780", "*" for any
#               host (cover art from anywhere), or "" for no network
#   SNAPCLIENT  snapclient binary name or absolute path (local playback)
#
# Permissions:
#   read   this directory (code) and the state dir
#   write  the state dir
#   net    only NET_ALLOW (the Snapcast server)
#   run    snapclient (local playback), secret-tool (server password)
#   env    HOME, XDG_RUNTIME_DIR (handed to snapclient for the audio server)
#   sys    hostname (default local client id)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
state_dir="${1:?state dir}"
net_allow="${2-}"
snapclient="${3:-snapclient}"
shift 3

deno_bin="$(command -v deno || true)"
if [[ -z $deno_bin ]]; then
  echo '{"event":"fatal","error":"Deno is not installed. Install it with: sudo pacman -S deno, then run: omarchy restart shell"}'
  exit 127
fi
deno_bin="$(readlink -f "$deno_bin")"

case "$state_dir" in
  /*) ;;
  *) echo '{"event":"fatal","error":"state dir must be absolute"}'; exit 2 ;;
esac
mkdir -p -m 700 "$state_dir"

# Resolve snapclient to an absolute path so --allow-run names exactly one binary.
if [[ $snapclient != /* ]]; then
  resolved="$(PATH=/usr/local/bin:/usr/bin command -v "$snapclient" || true)"
  snapclient="${resolved:-/usr/bin/snapclient}"
fi
secret_tool="$(PATH=/usr/local/bin:/usr/bin command -v secret-tool || echo /usr/bin/secret-tool)"

if [[ $net_allow == "*" ]]; then
  net_flag=(--allow-net)
elif [[ -n $net_allow ]]; then
  if [[ ! $net_allow =~ ^[][A-Za-z0-9.:,_-]+$ ]]; then
    echo '{"event":"fatal","error":"invalid network allow list"}'
    exit 2
  fi
  net_flag=(--allow-net="$net_allow")
else
  net_flag=()
fi

env_args=(
  HOME="$HOME"
  PATH=/usr/local/bin:/usr/bin
  LANG=C.UTF-8
  NO_COLOR=1
  DENO_DIR="${DENO_DIR:-$HOME/.cache/deno}"
  DENO_NO_UPDATE_CHECK=1
)
[[ -n ${XDG_RUNTIME_DIR:-} ]] && env_args+=(XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR")
[[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] && env_args+=(DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS")

# No third-party dependencies: the helper uses only Deno's runtime APIs, so
# there is nothing to download and it runs with --no-remote.
exec env -i "${env_args[@]}" "$deno_bin" run \
  --no-prompt --no-remote --no-npm --no-config --no-lock \
  --allow-read="$here/,${here%/helper}/lib,$state_dir" \
  --allow-write="$state_dir" \
  "${net_flag[@]}" \
  --allow-run="$snapclient,$secret_tool" \
  --allow-env=HOME,XDG_RUNTIME_DIR \
  --allow-sys=hostname \
  "$here/main.ts" --state-dir "$state_dir" --snapclient "$snapclient" "$@"
