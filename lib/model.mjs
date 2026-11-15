// Pure logic shared by the QML views and the Deno helper. ES module: QML
// imports it with `import "lib/model.mjs" as Model`, the helper and the tests
// import it directly. No QML, Qt or Deno APIs in here.
//
// Everything the Snapcast server sends is untrusted: normalize*() turn raw
// JSON-RPC payloads into a fixed, size-bounded shape before anything else
// looks at them.

const glyph = (cp) => String.fromCodePoint(cp)

// Nerd Font (Material Design) glyphs.
export const ICON = {
  bar: glyph(0xf04c3), // nf-md-speaker
  barOff: glyph(0xf04c4), // nf-md-speaker_off
  barPlaying: glyph(0xf071f), // nf-md-speaker_wireless
  volume: glyph(0xf057e), // nf-md-volume_high
  muted: glyph(0xf0581), // nf-md-volume_off
  play: glyph(0xf040a), // nf-md-play
  pause: glyph(0xf03e4), // nf-md-pause
  stop: glyph(0xf04db), // nf-md-stop
  previous: glyph(0xf04ae), // nf-md-skip_previous
  next: glyph(0xf04ad), // nf-md-skip_next
  shuffle: glyph(0xf049f), // nf-md-shuffle_variant
  repeat: glyph(0xf0456), // nf-md-repeat
  repeatOnce: glyph(0xf0458), // nf-md-repeat_once
  settings: glyph(0xf0493), // nf-md-cog
  more: glyph(0xf01d9), // nf-md-dots_vertical
  back: glyph(0xf004d), // nf-md-arrow_left
  streams: glyph(0xf0cb8), // nf-md-playlist_music
  add: glyph(0xf0415), // nf-md-plus
  remove: glyph(0xf0a7a), // nf-md-trash_can_outline
  info: glyph(0xf02fd), // nf-md-information_outline
  retry: glyph(0xf0450), // nf-md-refresh
  warning: glyph(0xf0026), // nf-md-alert
  music: glyph(0xf0387), // nf-md-music_note
  laptop: glyph(0xf0322), // nf-md-laptop
  group: glyph(0xf0d38), // nf-md-speaker_multiple
}

// ---------------------------------------------------------------- limits ----

export const LIMITS = {
  id: 128,
  name: 128,
  text: 512,
  url: 2048,
  groups: 128,
  clientsPerGroup: 128,
  clients: 256,
  streams: 128,
  artists: 16,
}

// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** Bounded string without control characters; anything else becomes "". */
export function str(value, max) {
  if (typeof value === "number" && isFinite(value)) value = String(value)
  if (typeof value !== "string") return ""
  return value.replace(CONTROL, "").slice(0, max || LIMITS.text)
}

function bool(value) {
  return value === true
}

function num(value, def, min, max) {
  const n = Number(value)
  if (!isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

/** Clamp a setting to an integer range, falling back on junk. */
export function clampInt(value, def, min, max) {
  const n = Number(value)
  if (!isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * Omarchy components such as Dropdown, Button and ConfirmDialog render their
 * text with Text.AutoText, which treats tag-shaped input as rich text and can
 * load remote resources (<img src=…>). A zero-width space after every "<"
 * keeps Qt's rich-text detection from seeing a tag, and looks identical.
 */
export function neutralize(value) {
  return String(value === undefined || value === null ? "" : value).replace(/</g, "<​")
}

// --------------------------------------------------------- normalization ----

function normVolume(v) {
  v = v && typeof v === "object" ? v : {}
  return { percent: clampInt(v.percent, 0, 0, 100), muted: bool(v.muted) }
}

export function normalizeClient(c) {
  c = c && typeof c === "object" ? c : {}
  const host = c.host && typeof c.host === "object" ? c.host : {}
  const config = c.config && typeof c.config === "object" ? c.config : {}
  const snap = c.snapclient && typeof c.snapclient === "object" ? c.snapclient : {}
  const seen = c.lastSeen && typeof c.lastSeen === "object" ? c.lastSeen : {}
  return {
    id: str(c.id, LIMITS.id),
    connected: bool(c.connected),
    config: {
      name: str(config.name, LIMITS.name),
      latency: clampInt(config.latency, 0, -10000, 10000),
      instance: clampInt(config.instance, 1, 0, 1000),
      volume: normVolume(config.volume),
    },
    host: {
      name: str(host.name, LIMITS.name),
      ip: str(host.ip, 64),
      mac: str(host.mac, 64),
      os: str(host.os, LIMITS.name),
      arch: str(host.arch, 64),
    },
    snapclient: {
      name: str(snap.name, 64),
      version: str(snap.version, 32),
      protocolVersion: clampInt(snap.protocolVersion, 0, 0, 1000),
    },
    lastSeen: clampInt(seen.sec, 0, 0, 1e11),
  }
}

export function normalizeGroup(g) {
  g = g && typeof g === "object" ? g : {}
  const clients = Array.isArray(g.clients) ? g.clients.slice(0, LIMITS.clientsPerGroup) : []
  return {
    id: str(g.id, LIMITS.id),
    name: str(g.name, LIMITS.name),
    muted: bool(g.muted),
    stream_id: str(g.stream_id, LIMITS.id),
    clients: clients.map(normalizeClient).filter((c) => c.id !== ""),
  }
}

function strList(value, maxItems, maxLen) {
  if (typeof value === "string") value = [value]
  if (!Array.isArray(value)) return []
  return value.slice(0, maxItems).map((v) => str(v, maxLen)).filter((v) => v !== "")
}

export function normalizeMetadata(m) {
  m = m && typeof m === "object" ? m : {}
  return {
    title: str(m.title, LIMITS.text),
    artist: strList(m.artist, LIMITS.artists, LIMITS.name),
    album: str(m.album, LIMITS.text),
    artUrl: str(m.artUrl, LIMITS.url),
    duration: num(m.duration, 0, 0, 1e7),
  }
}

const PLAYBACK = ["playing", "paused", "stopped"]
const LOOP = ["none", "track", "playlist"]

/**
 * Stream.properties. snapserver always sends the complete set and leaves out
 * what is unset (Properties::toJson), so a missing key means "cleared".
 */
export function normalizeProperties(p) {
  p = p && typeof p === "object" ? p : {}
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k)
  const pick = (k, fn, def) => has(k) ? fn(p[k]) : def
  return {
    playbackStatus: pick("playbackStatus", (v) => PLAYBACK.indexOf(v) !== -1 ? v : "stopped", "stopped"),
    loopStatus: pick("loopStatus", (v) => LOOP.indexOf(v) !== -1 ? v : "none", "none"),
    shuffle: pick("shuffle", bool, false),
    volume: pick("volume", (v) => clampInt(v, 100, 0, 100), 100),
    mute: pick("mute", bool, false),
    rate: pick("rate", (v) => num(v, 1, 0, 100), 1),
    position: pick("position", (v) => num(v, 0, 0, 1e7), 0),
    canGoNext: pick("canGoNext", bool, false),
    canGoPrevious: pick("canGoPrevious", bool, false),
    canPlay: pick("canPlay", bool, false),
    canPause: pick("canPause", bool, false),
    canSeek: pick("canSeek", bool, false),
    canControl: pick("canControl", bool, false),
    metadata: has("metadata") ? normalizeMetadata(p.metadata) : null,
  }
}

export function normalizeStream(s) {
  s = s && typeof s === "object" ? s : {}
  const uri = s.uri && typeof s.uri === "object" ? s.uri : {}
  const query = uri.query && typeof uri.query === "object" ? uri.query : {}
  const q = {}
  let n = 0
  for (const k in query) {
    if (n++ >= 32) break
    q[str(k, 64)] = str(query[k], LIMITS.text)
  }
  return {
    id: str(s.id, LIMITS.id),
    status: str(s.status, 32) || "unknown",
    uri: {
      raw: str(uri.raw, LIMITS.url),
      scheme: str(uri.scheme, 32),
      host: str(uri.host, 256),
      path: str(uri.path, 1024),
      query: q,
    },
    properties: normalizeProperties(s.properties),
  }
}

export function normalizeServer(raw) {
  raw = raw && typeof raw === "object" ? raw : {}
  if (raw.server && typeof raw.server === "object" && Array.isArray(raw.server.groups)) raw = raw.server
  const info = raw.server && typeof raw.server === "object" ? raw.server : {}
  const host = info.host && typeof info.host === "object" ? info.host : {}
  const snap = info.snapserver && typeof info.snapserver === "object" ? info.snapserver : {}
  const groups = (Array.isArray(raw.groups) ? raw.groups.slice(0, LIMITS.groups) : [])
    .map(normalizeGroup).filter((g) => g.id !== "")
  // A client id appears at most once, and the total stays bounded.
  const seen = {}
  let total = 0
  for (const g of groups) {
    g.clients = g.clients.filter((c) => {
      if (seen[c.id] || total >= LIMITS.clients) return false
      seen[c.id] = true
      total++
      return true
    })
  }
  const streamIds = {}
  const streams = (Array.isArray(raw.streams) ? raw.streams.slice(0, LIMITS.streams) : [])
    .map((s) => normalizeStream(s)).filter((s) => {
      if (s.id === "" || streamIds[s.id]) return false
      streamIds[s.id] = true
      return true
    })
  return {
    server: {
      host: { name: str(host.name, LIMITS.name), os: str(host.os, LIMITS.name), arch: str(host.arch, 64) },
      snapserver: {
        name: str(snap.name, 64),
        version: str(snap.version, 32),
        protocolVersion: clampInt(snap.protocolVersion, 0, 0, 1000),
        controlProtocolVersion: clampInt(snap.controlProtocolVersion, 0, 0, 1000),
      },
    },
    groups,
    streams,
  }
}

export function emptyServer() {
  return normalizeServer({})
}

// --------------------------------------------------------------- lookups ----

export function findClient(server, id) {
  if (!server) return null
  for (const g of server.groups) for (const c of g.clients) if (c.id === id) return c
  return null
}

export function findGroup(server, id) {
  if (!server) return null
  for (const g of server.groups) if (g.id === id) return g
  return null
}

export function groupOfClient(server, clientId) {
  if (!server) return null
  for (const g of server.groups) for (const c of g.clients) if (c.id === clientId) return g
  return null
}

export function findStream(server, id) {
  if (!server) return null
  for (const s of server.streams) if (s.id === id) return s
  return null
}

export function allClients(server) {
  const out = []
  if (!server) return out
  for (const g of server.groups) for (const c of g.clients) out.push(c)
  return out
}

/** Display name of a client: its configured name, else its host name (SnapWeb). */
export function clientName(c) {
  if (!c) return ""
  return c.config.name !== "" ? c.config.name : (c.host.name !== "" ? c.host.name : c.id)
}

/** Display name of a group: its name, else its members' names (Snapdroid). */
export function groupName(g) {
  if (!g) return ""
  if (g.name !== "") return g.name
  const names = g.clients.map(clientName).filter((n) => n !== "")
  return names.length > 0 ? names.join(", ") : g.id.slice(0, 8)
}

export function visibleClients(group, hideOffline) {
  if (!group) return []
  return group.clients.filter((c) => c.connected || !hideOffline)
}

/** Groups that have at least one visible client (SnapWeb hides the rest). */
export function visibleGroups(server, hideOffline) {
  if (!server) return []
  return server.groups.filter((g) => visibleClients(g, hideOffline).length > 0)
}

/** Average volume of a group's clients (SnapWeb getGroupVolume). */
export function groupVolume(group, onlineOnly) {
  if (!group || group.clients.length === 0) return 0
  let sum = 0
  let n = 0
  for (const c of group.clients) {
    if (onlineOnly && !c.connected) continue
    sum += c.config.volume.percent
    n++
  }
  return n === 0 ? 0 : sum / n
}

/**
 * New client volumes for a group volume change, SnapWeb's proportional
 * algorithm: `start` is [{id, percent}] captured when the drag began. Lowering
 * scales every client down by the same ratio; raising closes the same share of
 * each client's headroom to 100. Returns [{id, percent}] (integers).
 */
export function groupVolumeTargets(start, value) {
  if (!Array.isArray(start) || start.length === 0) return []
  value = num(value, 0, 0, 100)
  let avg = 0
  for (const s of start) avg += num(s.percent, 0, 0, 100)
  avg /= start.length
  const delta = value - avg
  let ratio
  if (delta < 0) ratio = avg <= 0 ? 0 : (avg - value) / avg
  else ratio = avg >= 100 ? 0 : (value - avg) / (100 - avg)
  return start.map((s) => {
    let v = num(s.percent, 0, 0, 100)
    if (delta < 0) v -= ratio * v
    else v += ratio * (100 - v)
    return { id: s.id, percent: Math.max(0, Math.min(100, Math.round(v))) }
  })
}

/** Snapshot of a group's volumes for groupVolumeTargets(). */
export function volumeSnapshot(group, hideOffline) {
  return visibleClients(group, hideOffline).map((c) => ({ id: c.id, percent: c.config.volume.percent }))
}

export function artistLine(meta) {
  return meta && meta.artist.length > 0 ? meta.artist.join(", ") : ""
}

/** Which transport controls a stream offers. */
export function controls(stream) {
  const p = stream ? stream.properties : null
  if (!p || !p.canControl) return { any: false, previous: false, playPause: false, next: false, seek: false, playing: false }
  return {
    any: true,
    previous: p.canGoPrevious,
    playPause: p.canPlay || p.canPause,
    next: p.canGoNext,
    seek: p.canSeek,
    playing: p.playbackStatus === "playing",
  }
}

export function nextLoopStatus(current) {
  const i = LOOP.indexOf(current)
  return LOOP[(i + 1) % LOOP.length]
}

// --------------------------------------------------------------- reducer ----

function clone(server) {
  return JSON.parse(JSON.stringify(server))
}

/**
 * Apply one JSON-RPC notification ({method, params}) to a normalized server
 * snapshot. Returns {server, changed, refresh}: `refresh` asks the caller to
 * fetch Server.GetStatus (an event about something the snapshot does not know).
 */
export function reduce(server, note) {
  const out = { server, changed: false, refresh: false }
  if (!note || typeof note !== "object" || typeof note.method !== "string") return out
  const p = note.params && typeof note.params === "object" ? note.params : {}
  const s = clone(server)
  const id = str(p.id, LIMITS.id)
  let client, group, stream
  switch (note.method) {
    case "Client.OnVolumeChanged":
      client = findClient(s, id)
      if (!client) return { server, changed: false, refresh: true }
      client.config.volume = normVolume(p.volume)
      break
    case "Client.OnLatencyChanged":
      client = findClient(s, id)
      if (!client) return { server, changed: false, refresh: true }
      client.config.latency = clampInt(p.latency, 0, -10000, 10000)
      break
    case "Client.OnNameChanged":
      client = findClient(s, id)
      if (!client) return { server, changed: false, refresh: true }
      client.config.name = str(p.name, LIMITS.name)
      break
    case "Client.OnConnect":
    case "Client.OnDisconnect": {
      const c = normalizeClient(p.client)
      if (c.id === "") return out
      // OnDisconnect carries the full client; OnConnect may be a new client
      // the server put into a group we don't know yet.
      group = groupOfClient(s, c.id)
      if (!group) return { server, changed: false, refresh: true }
      const i = group.clients.findIndex((x) => x.id === c.id)
      group.clients[i] = c
      break
    }
    case "Group.OnMute":
      group = findGroup(s, id)
      if (!group) return { server, changed: false, refresh: true }
      group.muted = bool(p.mute)
      break
    case "Group.OnStreamChanged":
      group = findGroup(s, id)
      if (!group) return { server, changed: false, refresh: true }
      group.stream_id = str(p.stream_id, LIMITS.id)
      break
    case "Group.OnNameChanged":
      group = findGroup(s, id)
      if (!group) return { server, changed: false, refresh: true }
      group.name = str(p.name, LIMITS.name)
      break
    case "Stream.OnUpdate": {
      const i = s.streams.findIndex((x) => x.id === id)
      if (i === -1) return { server, changed: false, refresh: true }
      s.streams[i] = normalizeStream(Object.assign({}, p.stream, { id }))
      break
    }
    case "Stream.OnProperties": {
      stream = findStream(s, id)
      if (!stream) return { server, changed: false, refresh: true }
      // The docs show the properties both nested under "properties" and flat
      // in params (with "metadata" directly inside); accept either.
      const props = p.properties && typeof p.properties === "object" ? p.properties : p
      stream.properties = normalizeProperties(props)
      break
    }
    case "Server.OnUpdate":
      return { server: normalizeServer(p.server), changed: true, refresh: false }
    default:
      return out
  }
  return { server: s, changed: true, refresh: false }
}

// -------------------------------------------------------- stream URIs -----

// Stream sources the Add stream form offers. `process` is left out on purpose:
// it runs an arbitrary program on the server host.
export const STREAM_TYPES = ["pipe", "tcp", "file", "alsa", "meta", "librespot", "airplay"]
export const CODECS = ["", "flac", "ogg", "opus", "pcm", "null"]

const NAME_RE = /^[A-Za-z0-9 _.()-]{1,64}$/
const PATH_RE = /^\/[A-Za-z0-9_.\/@+-]{0,1023}$/
const HOST_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9A-Fa-f:]{2,45}\]?)$/
const SAMPLEFORMAT_RE = /^\d{4,6}:(?:16|24|32):\d{1,2}$/
const DEVICE_RE = /^[A-Za-z0-9_:,.=-]{1,128}$/
const SCRIPT_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/
const WORD_RE = /^[A-Za-z0-9 _.-]{1,64}$/

export function validHost(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false
  if (!HOST_RE.test(value)) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.split(".").every((o) => Number(o) <= 255)
  return true
}

export function validPort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

function enc(value) {
  // RFC 3986 unreserved characters stay; everything else is percent-encoded.
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * Build a Stream.AddStream URI from the form's fields. Every field is checked
 * against a strict pattern and the query values are percent-encoded, so the
 * result cannot smuggle extra parameters. Returns {ok, uri} or {ok:false, field, error}.
 *
 * spec: {type, name, path, host, port, mode, codec, sampleformat, device,
 *        sources[], controlscript, devicename, bitrate}
 */
export function buildStreamUri(spec) {
  spec = spec && typeof spec === "object" ? spec : {}
  const fail = (field, error) => ({ ok: false, uri: "", field, error })
  const type = String(spec.type || "")
  if (STREAM_TYPES.indexOf(type) === -1) return fail("type", "unsupported stream type")
  const name = String(spec.name || "").trim()
  if (!NAME_RE.test(name)) return fail("name", "use 1–64 letters, digits, spaces or _ . ( ) -")
  const q = [["name", name]]
  let base

  switch (type) {
    case "pipe":
    case "file": {
      const path = String(spec.path || "")
      if (!PATH_RE.test(path) || path.indexOf("..") !== -1 || path.indexOf("//") !== -1) {
        return fail("path", "absolute path of letters, digits and _ . / @ + -")
      }
      base = type + "://" + path
      if (type === "pipe") {
        const mode = String(spec.mode || "create")
        if (mode !== "create" && mode !== "read") return fail("mode", "create or read")
        q.push(["mode", mode])
      }
      break
    }
    case "tcp": {
      const mode = String(spec.mode || "server")
      if (mode !== "server" && mode !== "client") return fail("mode", "server or client")
      const host = String(spec.host || (mode === "server" ? "0.0.0.0" : ""))
      if (!validHost(host)) return fail("host", "host name or IP address")
      const port = spec.port === undefined || spec.port === "" ? 4953 : Number(spec.port)
      if (!validPort(port)) return fail("port", "1–65535")
      const h = host.indexOf(":") !== -1 && host[0] !== "[" ? "[" + host + "]" : host
      base = "tcp://" + h + ":" + port
      q.push(["mode", mode])
      break
    }
    case "alsa": {
      const device = String(spec.device || "")
      if (!DEVICE_RE.test(device)) return fail("device", "ALSA device such as hw:0,1,0")
      base = "alsa:///"
      q.push(["device", device])
      break
    }
    case "meta": {
      const sources = Array.isArray(spec.sources) ? spec.sources.map((x) => String(x)) : []
      if (sources.length === 0 || sources.length > 16) return fail("sources", "pick 1–16 streams")
      for (const src of sources) if (!NAME_RE.test(src)) return fail("sources", "invalid source name")
      base = "meta:///" + sources.map(enc).join("/")
      break
    }
    case "librespot":
    case "airplay": {
      const path = String(spec.path || "")
      if (!PATH_RE.test(path) || path.indexOf("..") !== -1) return fail("path", "absolute path to the program on the server")
      base = type + "://" + path
      if (spec.devicename) {
        const dn = String(spec.devicename)
        if (!WORD_RE.test(dn)) return fail("devicename", "1–64 letters, digits, spaces or _ . -")
        q.push(["devicename", dn])
      }
      if (type === "librespot" && spec.bitrate) {
        const br = String(spec.bitrate)
        if (["96", "160", "320"].indexOf(br) === -1) return fail("bitrate", "96, 160 or 320")
        q.push(["bitrate", br])
      }
      break
    }
  }

  if (spec.codec) {
    const codec = String(spec.codec)
    if (CODECS.indexOf(codec) === -1) return fail("codec", "flac, ogg, opus, pcm or null")
    q.push(["codec", codec])
  }
  if (spec.sampleformat) {
    const sf = String(spec.sampleformat)
    if (!SAMPLEFORMAT_RE.test(sf)) return fail("sampleformat", "rate:bits:channels, e.g. 48000:16:2")
    q.push(["sampleformat", sf])
  }
  if (spec.controlscript) {
    // Only a file name: the server resolves it inside its [stream] plugin_dir
    // and rejects anything outside it.
    const cs = String(spec.controlscript)
    if (!SCRIPT_RE.test(cs)) return fail("controlscript", "file name of a script in the server's plug-in directory")
    q.push(["controlscript", cs])
  }
  const uri = base + "?" + q.map(([k, v]) => k + "=" + enc(v)).join("&")
  if (uri.length > LIMITS.url) return fail("", "stream URI too long")
  return { ok: true, uri, field: "", error: "" }
}

/** Stream ids the server would accept as meta sources (everything but meta itself). */
export function metaSourceCandidates(server) {
  return server ? server.streams.map((s) => s.id).filter((id) => NAME_RE.test(id)) : []
}

// ------------------------------------------------------------- settings ----

export function findEntrySettings(barConfig, id) {
  const layout = barConfig && barConfig.layout
  if (!layout || typeof layout !== "object") return {}
  for (const section of ["left", "centerBegin", "center", "centerEnd", "right", "tray"]) {
    const list = layout[section]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry && typeof entry === "object" && entry.id === id) return entry
    }
  }
  return {}
}

export const PLAYERS = ["pulse", "pipewire", "alsa"]
export const ART_POLICIES = ["server", "any", "off"]
export const HOSTID_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,63}$/
const SOUNDCARD_RE = /^(?:[A-Za-z0-9_:,.=@\/][A-Za-z0-9 _:,.=@\/-]{0,127})?$/
export const USER_RE = /^[A-Za-z0-9_.@-]{0,64}$/

/** The widget's inline shell.json entry, normalized (manifest barWidget.schema). */
export function normalizeSettings(raw) {
  raw = raw && typeof raw === "object" ? raw : {}
  const s = (v) => (typeof v === "string" ? v.trim() : "")
  const host = s(raw.host)
  const hostId = s(raw.localHostId)
  const soundcard = s(raw.localSoundcard)
  const user = s(raw.username)
  return {
    host: validHost(host) ? host : "",
    port: validPort(raw.port) ? Number(raw.port) : 1705,
    httpPort: validPort(raw.httpPort) ? Number(raw.httpPort) : 1780,
    streamPort: validPort(raw.streamPort) ? Number(raw.streamPort) : 1704,
    username: USER_RE.test(user) ? user : "",
    popupWidth: clampInt(raw.popupWidth, 420, 320, 1200),
    popupMaxHeight: clampInt(raw.popupMaxHeight, 640, 240, 2000),
    hideOffline: raw.hideOffline === true,
    showMetadata: raw.showMetadata !== false,
    coverArt: ART_POLICIES.indexOf(raw.coverArt) !== -1 ? raw.coverArt : "server",
    volumeStep: clampInt(raw.volumeStep, 5, 1, 25),
    localPlayback: raw.localPlayback === true,
    localPlayer: PLAYERS.indexOf(raw.localPlayer) !== -1 ? raw.localPlayer : "pulse",
    localSoundcard: SOUNDCARD_RE.test(soundcard) ? soundcard : "",
    localLatency: clampInt(raw.localLatency, 0, 0, 10000),
    localHostId: HOSTID_RE.test(hostId) ? hostId : "",
  }
}

/** Deno --allow-net list for the helper: only the server, unless cover art may come from anywhere. */
export function netAllowList(settings) {
  if (!settings || settings.host === "") return ""
  if (settings.coverArt === "any") return "*"
  const h = settings.host.indexOf(":") !== -1 && settings.host[0] !== "[" ? "[" + settings.host + "]" : settings.host
  const ports = [settings.port]
  if (settings.coverArt === "server" && ports.indexOf(settings.httpPort) === -1) ports.push(settings.httpPort)
  return ports.map((p) => h + ":" + p).join(",")
}

/** Name given to this computer's snapclient on the server: "<hostname> client". */
export function localClientName(hostname) {
  const clean = str(hostname, 48).replace(/[^A-Za-z0-9._-]/g, "")
  return (clean || "Omarchy") + " client"
}

/** Default local client id: stable per machine, recognisable in other UIs. */
export function defaultHostId(hostname) {
  const clean = String(hostname || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48)
  return "omarchy-" + (clean || "desktop")
}

/**
 * snapclient argv (without the binary). Version >= 0.32 takes the server as
 * a URL; older versions use -h/-p. Throws on invalid input: the caller
 * validated it already, so this is a second line of defence.
 */
export function snapclientArgs(opts, version) {
  opts = opts || {}
  if (!validHost(opts.host)) throw new Error("invalid host")
  if (!validPort(opts.port)) throw new Error("invalid port")
  if (!HOSTID_RE.test(opts.hostId || "")) throw new Error("invalid host id")
  if (PLAYERS.indexOf(opts.player) === -1) throw new Error("invalid player")
  if (!SOUNDCARD_RE.test(opts.soundcard || "")) throw new Error("invalid soundcard")
  const latency = clampInt(opts.latency, 0, 0, 10000)
  const args = ["--hostID", opts.hostId, "--player", opts.player, "--logsink", "stderr"]
  if (opts.soundcard) args.push("--soundcard", opts.soundcard)
  if (latency > 0) args.push("--latency", String(latency))
  const h = opts.host.indexOf(":") !== -1 && opts.host[0] !== "[" ? "[" + opts.host + "]" : opts.host
  if (versionAtLeast(version, 0, 32)) args.push("tcp://" + h + ":" + opts.port)
  else args.push("-h", opts.host, "-p", String(opts.port))
  return args
}

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function versionAtLeast(version, major, minor) {
  const v = Array.isArray(version) ? version : parseVersion(version)
  if (!v) return true // unknown: assume a current release
  return v[0] > major || (v[0] === major && v[1] >= minor)
}

/** Lines of `snapclient --list` → [{value, label}] (index:name pairs). */
export function parseSoundcards(text) {
  const out = []
  const lines = String(text || "").split("\n")
  for (let i = 0; i < lines.length && out.length < 64; i++) {
    const m = /^(\d+):\s*(.+)$/.exec(lines[i].trim())
    if (!m) continue
    const name = str(m[2], 128)
    const desc = i + 1 < lines.length && !/^\d+:/.test(lines[i + 1].trim()) ? str(lines[i + 1].trim(), 128) : ""
    if (SOUNDCARD_RE.test(name)) out.push({ value: name, label: desc ? name + " — " + desc : name })
  }
  return out
}

// -------------------------------------------------------------- display ----

/** "3 min ago"-style age of a lastSeen timestamp, in whole units (English fallback for logs). */
export function ageSeconds(lastSeen, nowSec) {
  if (!lastSeen) return -1
  return Math.max(0, Math.round(nowSec - lastSeen))
}

/** Bar icon for the connection/playback state. */
export function barIcon(connected, anyPlaying) {
  if (!connected) return ICON.barOff
  return anyPlaying ? ICON.barPlaying : ICON.bar
}

/**
 * The group the bar's scroll wheel controls: the one holding the local
 * client, else the first group with a connected client that plays something.
 */
export function targetGroup(server, localClientId, hideOffline) {
  if (!server) return null
  if (localClientId) {
    const g = groupOfClient(server, localClientId)
    if (g) return g
  }
  const visible = visibleGroups(server, hideOffline)
  for (const g of visible) {
    const st = findStream(server, g.stream_id)
    if (st && st.status === "playing" && visibleClients(g, true).length > 0) return g
  }
  return visible.length > 0 ? visible[0] : null
}

export function anyPlaying(server) {
  if (!server) return false
  for (const g of server.groups) {
    if (g.muted || !g.clients.some((c) => c.connected)) continue
    const st = findStream(server, g.stream_id)
    if (st && st.status === "playing") return true
  }
  return false
}
