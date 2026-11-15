#!/usr/bin/env bash
# Everything CI-like in one go: type check, lint, Deno tests (unit, RPC,
# art, integration, QML static checks), QML tests, qmllint, manifest check.
#
#   scripts/test.sh            all of it
#   SNAPCAST_LIVE=host[:port] scripts/test.sh   also the live tests against a real server
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo/helper"

echo "== deno check"; deno task -q check
echo "== deno lint"; deno task -q lint
echo "== deno test"; deno task -q test

echo "== qmltestrunner"
(cd "$repo/tests" && QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input qml -silent)

echo "== qmllint"
lint_root="$(mktemp -d)"
trap 'rm -rf "$lint_root"' EXIT
ln -s /usr/share/omarchy/shell "$lint_root/qs"
# Only real errors fail the run; the shell's untyped plugin API produces
# missing-property warnings that are expected.
if /usr/lib/qt6/bin/qmllint -I "$lint_root" -I /usr/lib/qt6/qml "$repo"/*.qml "$repo"/components/*.qml 2>&1 \
    | grep -E "^Error|property-override|no matching signal|is not a type|read-only" ; then
  echo "qmllint found problems" >&2
  exit 1
fi

echo "== omarchy plugin validate"
if command -v omarchy >/dev/null; then omarchy plugin validate "$repo"; else echo "(omarchy not installed; skipped)"; fi
echo "all checks passed"
