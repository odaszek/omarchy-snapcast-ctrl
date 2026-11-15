// SnapcastCtrl helper process. Started and owned by Service.qml via start.sh.
//
//   deno run <permissions> main.ts --state-dir DIR --host H [--port 1705] [--http-port 1780]
//        [--stream-port 1704] [--art server|any|off] [--username U] [--snapclient BIN] [--verbose]
//
// Talks newline-delimited JSON on stdin/stdout with the shell (docs/ipc.md):
//   requests  {"id":1,"op":"setClientVolume","clientId":"…","percent":40}
//   replies   {"id":1,"ok":true,"result":{…}}  /  {"id":1,"ok":false,"error":"…"}
//   events    {"event":"status","server":{…}}
// and JSON-RPC 2.0 over TCP with snapserver (rpc_client.ts).

import { ArtCache, resolveArtUrl } from "./art.ts"
import { FileLogger } from "./log.ts"
import { LineSplitter, SnapcastRpc } from "./rpc_client.ts"
import { KeyringSecrets } from "./secrets.ts"
import { SnapclientSupervisor } from "./snapclient.ts"
import * as Model from "../lib/model.mjs"

export const VERSION = "0.1.0"
const MAX_REQUEST_LINE = 256 * 1024
const STATUS_THROTTLE_MS = 40

// ------------------------------------------------------------------ args ----

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i]
    else out[a.slice(2)] = true
  }
  return out
}

const args = parseArgs(Deno.args)
const stateDir = String(args["state-dir"] ?? "").replace(/\/+$/, "")
if (!stateDir.startsWith("/")) {
  console.error("usage: main.ts --state-dir /abs/path --host HOST [options]")
  Deno.exit(2)
}
const settings = Model.normalizeSettings({
  host: String(args.host ?? ""),
  port: Number(args.port ?? 1705),
  httpPort: Number(args["http-port"] ?? 1780),
  streamPort: Number(args["stream-port"] ?? 1704),
  coverArt: String(args.art ?? "server"),
  username: String(args.username ?? ""),
})
const snapclientBin = typeof args.snapclient === "string" ? args.snapclient : "snapclient"

await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 })
const log = new FileLogger(stateDir + "/logs", !!args.verbose)

// ---------------------------------------------------------------- stdout ----

const encoder = new TextEncoder()
let stdoutChain: Promise<void> = Promise.resolve()
function emit(obj: Record<string, unknown>): void {
  const line = encoder.encode(JSON.stringify(obj) + "\n")
  stdoutChain = stdoutChain.then(async () => {
    try {
      let written = 0
      while (written < line.length) written += await Deno.stdout.write(line.subarray(written))
    } catch { /* the shell went away; stdin EOF stops us */ }
  })
}

log.onLog((level, message) => {
  if (level === "warn" || level === "error") emit({ event: "log", level, message })
})

// --------------------------------------------------------- single instance ----

const lockFile = await Deno.open(stateDir + "/helper.lock", { create: true, write: true, mode: 0o600 })
const locked = await Promise.race([
  lockFile.lock(true).then(() => true),
  new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
])
if (!locked) {
  log.error("another SnapcastCtrl helper is already running for " + stateDir)
  emit({ event: "fatal", error: "Another helper instance is already running" })
  await stdoutChain
  Deno.exit(3)
}

// ----------------------------------------------------------------- state ----

type Server = ReturnType<typeof Model.emptyServer>

let server: Server = Model.emptyServer()
let rpcVersion = ""
let connState = "idle"
let connError = ""
const art = new ArtCache(stateDir, log)
const secrets = new KeyringSecrets(log)

let statusTimer: ReturnType<typeof setTimeout> | undefined
function scheduleStatus(): void {
  if (statusTimer) return
  statusTimer = setTimeout(() => {
    statusTimer = undefined
    emitStatus()
  }, STATUS_THROTTLE_MS)
}

/** The snapshot plus a local `artFile` per stream (empty until the image is cached). */
function view(): Server {
  const out = JSON.parse(JSON.stringify(server)) as Server
  for (const st of out.streams as Record<string, unknown>[]) {
    const props = st.properties as { metadata: { artUrl: string } | null }
    const url = props.metadata ? resolveArtUrl(props.metadata.artUrl, settings.coverArt, settings.host, settings.httpPort) : ""
    let file = ""
    if (url) {
      const known = art.peek(url)
      if (known === undefined) art.get(url).then((p) => p && scheduleStatus())
      else file = known
    }
    st.artFile = file
  }
  return out
}

function emitStatus(): void {
  emit({ event: "status", server: view() })
}

function emitConnection(): void {
  emit({
    event: "connection",
    state: connState,
    error: connError,
    host: settings.host,
    port: settings.port,
    rpcVersion,
    serverVersion: server.server.snapserver.version,
  })
}

function apply(method: string, params: unknown): void {
  const r = Model.reduce(server, { method, params })
  if (r.changed) {
    server = r.server
    scheduleStatus()
  }
  if (r.refresh) refreshStatus()
}

let refreshing: Promise<void> | null = null
function refreshStatus(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const res = await rpc.request("Server.GetStatus") as Record<string, unknown>
      server = Model.normalizeServer(res)
      scheduleStatus()
    } catch (e) {
      log.debug("GetStatus failed: " + errText(e))
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ------------------------------------------------------------------- rpc ----

const rpc = new SnapcastRpc({
  host: settings.host,
  port: settings.port,
  log,
  async onConnected(r) {
    if (settings.username) {
      const password = await secrets.get(settings.host, settings.username)
      if (password !== null) {
        const param = btoa(String.fromCharCode(...new TextEncoder().encode(settings.username + ":" + password)))
        try {
          await r.request("Server.Authenticate", { scheme: "Basic", param })
        } catch (e) {
          throw new Error("authentication failed: " + errText(e))
        }
      }
    }
    try {
      const v = await r.request("Server.GetRPCVersion") as Record<string, unknown>
      rpcVersion = [v?.major, v?.minor, v?.patch].map((x) => Model.clampInt(x, 0, 0, 999)).join(".")
    } catch (e) {
      if ((e as { code?: number }).code === 401) throw new Error("authentication required (set a user name and password)")
      rpcVersion = ""
    }
    const res = await r.request("Server.GetStatus") as Record<string, unknown>
    server = Model.normalizeServer(res)
    emitStatus()
  },
  onNotification(method, params) {
    apply(method, params)
  },
  onState(state, error) {
    connState = state
    connError = error
    if (state === "disconnected") {
      server = Model.emptyServer()
      emitStatus()
    }
    emitConnection()
  },
})

// ------------------------------------------------------- volume coalescing ----
// Sliders send many changes per second. Per client, at most one
// Client.SetVolume is in flight; newer values replace older queued ones.

interface VolumeWant {
  percent: number
  muted: boolean
}
const volumeQueue = new Map<string, VolumeWant>()
const volumeInFlight = new Set<string>()

function queueVolume(clientId: string, want: VolumeWant): void {
  // Optimistic: show it now. The response confirms it.
  apply("Client.OnVolumeChanged", { id: clientId, volume: want })
  volumeQueue.set(clientId, want)
  pumpVolume(clientId)
}

function pumpVolume(clientId: string): void {
  if (volumeInFlight.has(clientId)) return
  const want = volumeQueue.get(clientId)
  if (!want) return
  volumeQueue.delete(clientId)
  volumeInFlight.add(clientId)
  rpc.request("Client.SetVolume", { id: clientId, volume: { percent: want.percent, muted: want.muted } })
    .then((res) => {
      const r = res as Record<string, unknown>
      // A newer value is queued: don't flash the older one.
      if (!volumeQueue.has(clientId) && r && r.volume) apply("Client.OnVolumeChanged", { id: clientId, volume: r.volume })
    })
    .catch((e) => {
      log.warn("set volume failed for " + clientId + ": " + errText(e))
      if (!volumeQueue.has(clientId)) refreshStatus()
    })
    .finally(() => {
      volumeInFlight.delete(clientId)
      pumpVolume(clientId)
    })
}

// ------------------------------------------------------------- local player ----

const local = new SnapclientSupervisor(snapclientBin, log, (s) => emit({ event: "local", ...s }))

function localOptions(p: Record<string, unknown>) {
  const s = Model.normalizeSettings({
    host: settings.host,
    localPlayer: p.player,
    localSoundcard: p.soundcard,
    localLatency: p.latency,
    localHostId: p.hostId,
  })
  let hostname = ""
  try {
    hostname = Deno.hostname()
  } catch { /* no sys permission */ }
  return {
    host: settings.host,
    port: settings.streamPort,
    hostId: s.localHostId || Model.defaultHostId(hostname),
    player: s.localPlayer,
    soundcard: s.localSoundcard,
    latency: s.localLatency,
  }
}

// ------------------------------------------------------------------- ops ----

function id(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== "string" || v.length === 0 || v.length > Model.LIMITS.id) throw new Error("invalid " + key)
  return v
}

function needConnected(): void {
  if (!rpc.connected) throw new Error("not connected to the Snapcast server")
}

type Handler = (p: Record<string, unknown>) => Promise<unknown> | unknown

const STREAM_COMMANDS = ["play", "pause", "playPause", "stop", "next", "previous", "seek", "setPosition"]
const STREAM_PROPERTIES: Record<string, (v: unknown) => unknown> = {
  loopStatus: (v) => {
    if (v !== "none" && v !== "track" && v !== "playlist") throw new Error("invalid loopStatus")
    return v
  },
  shuffle: (v) => v === true,
  mute: (v) => v === true,
  volume: (v) => Model.clampInt(v, 100, 0, 100),
  rate: (v) => {
    const n = Number(v)
    if (!isFinite(n) || n <= 0 || n > 10) throw new Error("invalid rate")
    return n
  },
}

const ops: Record<string, Handler> = {
  ping: () => ({ version: VERSION }),

  status: () => ({ server: view(), connection: { state: connState, error: connError, rpcVersion } }),

  reconnect: () => {
    rpc.reconnect()
    return {}
  },

  refresh: async () => {
    needConnected()
    await refreshStatus()
    return {}
  },

  // ---- clients ----
  setClientVolume: (p) => {
    needConnected()
    const cid = id(p, "clientId")
    const c = Model.findClient(server, cid)
    if (!c) throw new Error("unknown client")
    const percent = p.percent === undefined ? c.config.volume.percent : Model.clampInt(p.percent, 0, 0, 100)
    const muted = p.muted === undefined ? c.config.volume.muted : p.muted === true
    queueVolume(cid, { percent, muted })
    return {}
  },

  // Several clients at once (group volume); one batch per call.
  setVolumes: (p) => {
    needConnected()
    const list = Array.isArray(p.volumes) ? p.volumes.slice(0, Model.LIMITS.clients) : []
    for (const v of list as Record<string, unknown>[]) {
      const cid = id(v, "id")
      const c = Model.findClient(server, cid)
      if (!c) continue
      queueVolume(cid, { percent: Model.clampInt(v.percent, 0, 0, 100), muted: c.config.volume.muted })
    }
    return {}
  },

  setClientName: async (p) => {
    needConnected()
    const cid = id(p, "clientId")
    const name = Model.str(p.name, Model.LIMITS.name).trim()
    const res = await rpc.request("Client.SetName", { id: cid, name }) as Record<string, unknown>
    apply("Client.OnNameChanged", { id: cid, name: res && typeof res.name === "string" ? res.name : name })
    return {}
  },

  setClientLatency: async (p) => {
    needConnected()
    const cid = id(p, "clientId")
    const latency = Model.clampInt(p.latency, 0, -10000, 10000)
    const res = await rpc.request("Client.SetLatency", { id: cid, latency }) as Record<string, unknown>
    apply("Client.OnLatencyChanged", { id: cid, latency: res && res.latency !== undefined ? res.latency : latency })
    return {}
  },

  deleteClient: async (p) => {
    needConnected()
    const cid = id(p, "clientId")
    const res = await rpc.request("Server.DeleteClient", { id: cid }) as Record<string, unknown>
    if (res && res.server) apply("Server.OnUpdate", { server: res.server })
    else await refreshStatus()
    return {}
  },

  // ---- groups ----
  setGroupMute: async (p) => {
    needConnected()
    const gid = id(p, "groupId")
    const mute = p.mute === true
    apply("Group.OnMute", { id: gid, mute })
    try {
      const res = await rpc.request("Group.SetMute", { id: gid, mute }) as Record<string, unknown>
      if (res && typeof res.mute === "boolean") apply("Group.OnMute", { id: gid, mute: res.mute })
    } catch (e) {
      await refreshStatus()
      throw e
    }
    return {}
  },

  setGroupName: async (p) => {
    needConnected()
    const gid = id(p, "groupId")
    const name = Model.str(p.name, Model.LIMITS.name).trim()
    const res = await rpc.request("Group.SetName", { id: gid, name }) as Record<string, unknown>
    apply("Group.OnNameChanged", { id: gid, name: res && typeof res.name === "string" ? res.name : name })
    return {}
  },

  setGroupStream: async (p) => {
    needConnected()
    const gid = id(p, "groupId")
    const sid = id(p, "streamId")
    if (!Model.findStream(server, sid)) throw new Error("unknown stream")
    apply("Group.OnStreamChanged", { id: gid, stream_id: sid })
    try {
      await rpc.request("Group.SetStream", { id: gid, stream_id: sid })
    } catch (e) {
      await refreshStatus()
      throw e
    }
    return {}
  },

  setGroupClients: async (p) => {
    needConnected()
    const gid = id(p, "groupId")
    const clients = (Array.isArray(p.clients) ? p.clients : []).slice(0, Model.LIMITS.clients)
      .filter((c) => typeof c === "string" && c.length > 0 && c.length <= Model.LIMITS.id)
    const res = await rpc.request("Group.SetClients", { id: gid, clients }) as Record<string, unknown>
    if (res && res.server) apply("Server.OnUpdate", { server: res.server })
    else await refreshStatus()
    return {}
  },

  // ---- streams ----
  streamControl: async (p) => {
    needConnected()
    const sid = id(p, "streamId")
    const command = String(p.command ?? "")
    if (STREAM_COMMANDS.indexOf(command) === -1) throw new Error("invalid command")
    const params: Record<string, unknown> = {}
    if (command === "seek") {
      const offset = Number((p.params as Record<string, unknown> | undefined)?.offset)
      if (!isFinite(offset) || Math.abs(offset) > 1e6) throw new Error("invalid offset")
      params.offset = offset
    } else if (command === "setPosition") {
      const position = Number((p.params as Record<string, unknown> | undefined)?.position)
      if (!isFinite(position) || position < 0 || position > 1e7) throw new Error("invalid position")
      params.position = position
    }
    const msg: Record<string, unknown> = { id: sid, command }
    if (Object.keys(params).length > 0) msg.params = params
    await rpc.request("Stream.Control", msg)
    return {}
  },

  streamSetProperty: async (p) => {
    needConnected()
    const sid = id(p, "streamId")
    const property = String(p.property ?? "")
    const check = STREAM_PROPERTIES[property]
    if (!check) throw new Error("invalid property")
    await rpc.request("Stream.SetProperty", { id: sid, property, value: check(p.value) })
    return {}
  },

  addStream: async (p) => {
    needConnected()
    const built = Model.buildStreamUri(p.spec)
    if (!built.ok) return { added: false, field: built.field, error: built.error }
    const res = await rpc.request("Stream.AddStream", { streamUri: built.uri }) as Record<string, unknown>
    await refreshStatus()
    return { added: true, streamId: Model.str(res && (res.id ?? res.stream_id), Model.LIMITS.id) }
  },

  removeStream: async (p) => {
    needConnected()
    const sid = id(p, "streamId")
    await rpc.request("Stream.RemoveStream", { id: sid })
    await refreshStatus()
    return {}
  },

  // ---- local playback ----
  localStatus: async () => {
    await local.detect()
    return local.status()
  },

  localStart: async (p) => {
    if (!settings.host) throw new Error("no server configured")
    await local.start(localOptions(p))
    return local.status()
  },

  localStop: async () => {
    await local.stop()
    return local.status()
  },

  listSoundcards: async (p) => {
    await local.detect()
    return { soundcards: await local.listSoundcards(String(p.player ?? "pulse")) }
  },

  localClientId: (p) => ({ clientId: localOptions(p).hostId }),

  // ---- credentials ----
  hasPassword: async () => {
    if (!settings.username || !settings.host) return { stored: false }
    return { stored: (await secrets.get(settings.host, settings.username)) !== null }
  },

  setPassword: async (p) => {
    if (!settings.username || !settings.host) throw new Error("set the server and user name first")
    const password = typeof p.password === "string" ? p.password : ""
    if (password.length === 0) await secrets.remove(settings.host, settings.username)
    else if (password.length > 256) throw new Error("password too long")
    else await secrets.set(settings.host, settings.username, password)
    rpc.reconnect()
    return {}
  },
}

async function handleRequest(msg: Record<string, unknown>): Promise<void> {
  const rid = msg.id
  const op = String(msg.op ?? "")
  const handler = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null
  if (!handler) {
    emit({ id: rid, ok: false, error: "unknown op " + op.slice(0, 40) })
    return
  }
  try {
    const result = await handler(msg)
    emit({ id: rid, ok: true, result: result ?? {} })
  } catch (e) {
    emit({ id: rid, ok: false, error: errText(e).slice(0, 400) })
  }
}

// ------------------------------------------------------------ lifecycle ----

let stopping = false
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true
    local.killNow()
    rpc.stop()
    await Promise.race([stdoutChain, new Promise((r) => setTimeout(r, 500))])
  }
  Deno.exit(code)
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  try {
    Deno.addSignalListener(sig, () => shutdown(0))
  } catch { /* unsupported */ }
}

emit({ event: "ready", version: VERSION, host: settings.host })
if (settings.host) {
  rpc.start()
} else {
  connState = "unconfigured"
  emitConnection()
}
local.detect()

const splitter = new LineSplitter(MAX_REQUEST_LINE)
const buf = new Uint8Array(64 * 1024)
for (;;) {
  let n: number | null
  try {
    n = await Deno.stdin.read(buf)
  } catch {
    n = null
  }
  if (n === null) break
  for (const line of splitter.push(buf.subarray(0, n))) {
    if (line.trim() === "") continue
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg && typeof msg === "object" && !Array.isArray(msg)) handleRequest(msg as Record<string, unknown>)
  }
}
await shutdown(0)
