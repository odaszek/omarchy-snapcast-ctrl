#!/usr/bin/env bash
# Install or update the SnapcastCtrl plugin for the Omarchy shell.
#
#   scripts/install.sh           install/update and (first time) add it to the bar's right section
#   scripts/install.sh --watch   development: re-copy on every save in this checkout (needs inotifywait)
#   scripts/install.sh --no-enable   install without touching the bar layout
#   scripts/install.sh --no-restart  update files without restarting the shell
#
# Omarchy does not allow symlinks inside plugin folders, so the plugin is
# copied into ~/.config/omarchy/plugins/odach.snapcast-ctrl.
#
# Updates restart the shell (`omarchy restart shell`): the shell keeps the
# Snapcast service loaded across plugin reloads (keepLoaded) and caches compiled
# QML and JS modules, so a hot reload alone does not apply every change.
set -euo pipefail

id="odach.snapcast-ctrl"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
plugins="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
target="$plugins/$id"
staging="$plugins/.$id.staging"
files=(manifest.json Service.qml BarWidget.qml components lib i18n helper README.md LICENSE)

watch=false
enable=true
restart=true
for arg in "$@"; do
  case "$arg" in
    --watch) watch=true ;;
    --no-enable) enable=false ;;
    --no-restart) restart=false ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ensure_deno() {
  if ! command -v deno >/dev/null; then
    echo "SnapcastCtrl needs Deno (it runs the Snapcast connection helper)."
    if [[ -t 0 ]]; then
      sudo pacman -S --needed deno
    else
      echo "Install it with: sudo pacman -S deno" >&2
      exit 1
    fi
  fi
  command -v snapclient >/dev/null || echo "Note: snapclient is not installed; local playback needs it: omarchy pkg aur add snapcast"
}

sync_files() {
  rm -rf "$staging"
  mkdir -p "$staging"
  for f in "${files[@]}"; do
    [[ -e $repo/$f ]] && cp -R "$repo/$f" "$staging/"
  done
  find "$staging" \( -name '*.swp' -o -name '*~' -o -name node_modules \) -prune -exec rm -rf {} +
  # Explicit `|| return`: errexit is off when this runs inside `sync_files && …`.
  omarchy plugin validate "$staging" >/dev/null || { echo "plugin validation failed; not installed" >&2; return 1; }

  local parked="$plugins/.$id.old"
  [[ -d $target ]] && mv "$target" "$parked"
  mv "$staging" "$target"
  rm -rf "$parked"
}

ensure_deno
mkdir -p "$plugins"
first_install=false
[[ -d $target ]] || first_install=true
sync_files
echo "Installed $id to $target"

restart_shell() {
  echo "Restarting the Omarchy shell to load the new version…"
  omarchy restart shell >/dev/null 2>&1 || echo "Restart it yourself: omarchy restart shell" >&2
}

if $enable && $first_install; then
  # The shell discovers new plugins asynchronously; ask it to rescan, then enable.
  omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if omarchy plugin enable "$id" --section right 2>/dev/null; then
      echo "Added to the bar (right section). Move it with: omarchy bar move $id --section <section>"
      break
    fi
    sleep 0.5
  done
elif ! $first_install && $restart; then
  restart_shell
fi

if $watch; then
  command -v inotifywait >/dev/null || { echo "--watch needs inotifywait (inotify-tools)" >&2; exit 1; }
  echo "Watching $repo for changes (Ctrl+C to stop)…"
  while inotifywait -qq -r -e close_write,create,delete,move \
      --exclude '(/\.git/|/tests/|/docs/|\.swp$|~$)' "$repo"; do
    sleep 0.2
    sync_files && echo "$(date +%T) synced" && $restart && restart_shell
  done
fi
