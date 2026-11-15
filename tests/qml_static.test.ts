// Static checks over the plugin's QML: every text sink is plain text, no
// remote resources are loaded, and every translation key used exists.

import { assert, assertEquals } from "./_assert.ts"

const root = new URL("../", import.meta.url).pathname
const files: string[] = []
for (const dir of ["", "components/"]) {
  for (const e of Deno.readDirSync(root + dir)) if (e.isFile && e.name.endsWith(".qml")) files.push(dir + e.name)
}

function read(f: string): string {
  return Deno.readTextFileSync(root + f)
}

Deno.test("QML files exist", () => {
  assert(files.includes("BarWidget.qml") && files.includes("Service.qml") && files.includes("components/PlainText.qml"))
})

Deno.test("text is only rendered through PlainText (never AutoText/RichText/StyledText)", () => {
  for (const f of files) {
    const src = read(f)
    if (f === "components/PlainText.qml") {
      assert(src.includes("textFormat: Text.PlainText"), "PlainText sets Text.PlainText")
      continue
    }
    // A bare `Text {` element would default to Text.AutoText.
    const bare = src.split("\n").filter((l) => /^\s*Text\s*\{/.test(l))
    assertEquals(bare, [], f + " uses a bare Text element")
    for (const fmt of ["Text.AutoText", "Text.RichText", "Text.StyledText", "Text.MarkdownText"]) {
      assert(!src.includes(fmt), f + " uses " + fmt)
    }
    assert(!/\bTextEdit\s*\{/.test(src), f + " uses TextEdit (rich text capable)")
  }
})

Deno.test("no remote resources: Images load only local files", () => {
  for (const f of files) {
    const src = read(f)
    assert(!/https?:\/\//.test(src.replace(/\/\/.*$/gm, "")), f + " contains an http(s) URL")
    for (const m of src.matchAll(/source:\s*([^\n]+)/g)) {
      assert(/"file:\/\/"|^""$/.test(m[1]) || m[1].includes('"file://" +'), f + " Image source not file://: " + m[1])
    }
  }
})

Deno.test("Qt.openUrlExternally and execDetached are not used", () => {
  for (const f of files) {
    const src = read(f)
    assert(!src.includes("openUrlExternally"), f)
    assert(!src.includes("execDetached"), f)
  }
})

Deno.test("tooltips with server data are neutralized", () => {
  const src = read("BarWidget.qml")
  const m = /readonly property string barTooltip: \{([\s\S]*?)\n {2}\}/.exec(src)
  assert(m, "barTooltip found")
  assert(m[1].includes("Model.neutralize(Model.groupName(g))"), "group name in the bar tooltip is neutralized")
})

Deno.test("server text handed to Omarchy components (labels, dialogs) is neutralized", () => {
  // Dropdown/Toggle labels and ConfirmDialog messages are rendered by the
  // shell's own components, not PlainText.
  const serverText = /Model\.clientName\(|Model\.groupName\(|\bs\.id\b|modelData\.id\b/
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      if (!/\blabel:|app\.confirm\(|tooltipText:/.test(line) || !serverText.test(line)) return
      assert(line.includes("Model.neutralize("), f + ":" + (i + 1) + " passes server text without Model.neutralize()")
    })
  }
})

Deno.test("every translation key used in QML exists in en.json", () => {
  const en = JSON.parse(Deno.readTextFileSync(root + "i18n/en.json")) as Record<string, unknown>
  const missing: string[] = []
  for (const f of files) {
    for (const m of read(f).matchAll(/strings\.t\("([^"]+)"(,)?/g)) {
      const key = m[1]
      if (key.endsWith(".")) continue // dynamic suffix, checked below
      if (!(key in en)) missing.push(f + ": " + key)
    }
  }
  assertEquals(missing, [])
  // Dynamic families.
  for (const t of ["pipe", "tcp", "file", "alsa", "meta", "librespot", "airplay"]) {
    assert("addStream.types." + t in en && "addStream.typeHint." + t in en, t)
  }
  for (const p of ["server", "any", "off"]) assert("settings.coverArt." + p in en && "settings.coverArtHint." + p in en, p)
  for (const p of ["pulse", "pipewire", "alsa"]) assert("settings.player." + p in en, p)
  for (const s of ["unavailable", "stopped", "starting", "running", "restarting", "error"]) assert("local.state." + s in en, s)
  for (const s of ["connected", "connecting", "disconnected", "idle", "unconfigured"]) assert("settings.state." + s in en, s)
})

Deno.test("manifest defaults match lib/model.mjs normalizeSettings defaults", async () => {
  const M = await import("../lib/model.mjs")
  const manifest = JSON.parse(Deno.readTextFileSync(root + "manifest.json"))
  const defaults = manifest.barWidget.defaults as Record<string, unknown>
  const normalized = M.normalizeSettings(defaults) as Record<string, unknown>
  for (const [k, v] of Object.entries(defaults)) assertEquals(normalized[k], v, k)
  for (const field of manifest.barWidget.schema as { key: string; defaultValue: unknown }[]) {
    assertEquals(field.defaultValue, defaults[field.key], "schema default " + field.key)
  }
})
