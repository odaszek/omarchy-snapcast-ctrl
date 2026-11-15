# CLAUDE.md

SnapcastCtrl is a third-party plugin for the **Omarchy 4.5 shell** (Quickshell 0.3 / Qt 6.12 QML):
a bar widget + panel that controls a Snapcast server (SnapWeb feature parity) and can play locally
through a supervised `snapclient`. User docs: `README.md`; helper protocol: `docs/ipc.md`; tests and
the SnapWeb parity checklist: `docs/testing.md`; security model: `docs/security.md`.

## Commands

```bash
scripts/test.sh                       # everything: check, lint, Deno tests, qmltestrunner, qmllint, validate
cd helper && deno task test           # Deno tests only (~8 s)
cd helper && deno task check | lint | fmt
scripts/install.sh                    # copy into ~/.config/omarchy/plugins/odach.snapcast-ctrl + restart shell
deno run --allow-net --allow-read tests/tools/mock_snapserver.ts 17050 17800   # fake server for UI work
omarchy-shell shell summon odach.snapcast-ctrl                                  # open the panel
cd helper && SNAPCAST_LIVE=host deno test --allow-all ../tests/live.test.ts     # against a real server
```

## Architecture

- `manifest.json`: kinds `service` + `bar-widget`, `keepLoaded`. No `panel` kind on purpose: it
  would reroute `shell summon` to a panel loader; settings are a page inside the popup instead.
- `Service.qml`: parentless long-lived object. Owns the helper `Process` (restart with backoff;
  relaunch when host/ports/art policy/user change, because Deno's `--allow-net` is fixed at start),
  holds `server` (normalized snapshot), `groupIds`, connection and local-player state, and all ops.
  Settings: the widget's inline entry in `shell.json`, read by **watching the file** (`FileView`):
  the shell refreshes a plugin's `shell.barConfig` only when plugins change, not on edits.
  Writes go through `shell.updateEntryInline`; `pendingSettings` overlays our own writes until
  the file watch reports them. The helper starts only once the settings are loaded.
- `BarWidget.qml`: `Panel` + `BarIconButton` + `KeyboardPanel`. Page stack (`page`, `pageArg`,
  `history`) with a `Loader`; set `pageArg` before `page` (the Loader builds on `page` change).
  Pages/components in `components/` get the panel as `app` (`app.service`, `app.strings`, `app.fg`…).
  Don't name a property `settings` on the widget: `Panel` already has one (injected by the bar).
- Rows are keyed by id arrays (`service.groupIds`, `GroupCard.clientIds`) that are reassigned only
  when membership changes, so delegates and a dragged slider survive volume notifications.
- `lib/model.mjs`: pure ES module shared by QML, helper and tests — normalization/bounds, reducer
  for every notification, SnapWeb group-volume algorithm, stream URI builder/validation, settings
  normalization, `--allow-net` list, snapclient argv, glyphs. Keep Qt/Deno APIs out of it.
- `helper/` (Deno, no dependencies): `main.ts` (ops, snapshot, own-change application — snapserver
  never echoes notifications to the requesting session — volume coalescing, status throttling),
  `rpc_client.ts` (TCP NDJSON JSON-RPC, batches, timeouts, reconnect), `art.ts` (cover-art policy and
  cache), `snapclient.ts` (supervisor), `secrets.ts` (keyring), `log.ts`. `start.sh` is the single
  source of permissions.

## Omarchy 4.5 behaviours that matter (verified)

- Hot reload doesn't apply QML/.mjs changes to the keepLoaded service; `scripts/install.sh` restarts the shell.
- Plugin folders can't contain symlinks; install copies files.
- Plugin `console.log` doesn't reach the shell log, but QML errors do:
  `qs log /run/user/$UID/quickshell/by-id/<newest>/log.qslog | grep snapcast`.
- Loader's `implicitHeight` is read-only; the panel's content height must not depend on the
  KeyboardPanel's height (binding loop → zero-height body).
- Every file using `Commons.I18n` / `Commons.Color` needs `import qs.Commons as Commons`.

## Rules

- Never edit `/usr/share/omarchy/`.
- Server-derived text only through `components/PlainText.qml`; `Model.neutralize()` for text handed
  to Omarchy components/tooltips. `tests/qml_static.test.ts` enforces this; keep it passing.
- User-visible strings in `i18n/en.json` via `strings.t()` inside bindings; logs in English;
  durations via `Style.duration()`.
- Nerd Font glyphs: check codepoints against nerd-fonts `glyphnames.json` (several `md-*` names
  moved between versions).
