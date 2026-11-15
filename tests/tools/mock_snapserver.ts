// A stateful fake snapserver for tests and manual UI work: JSON-RPC 2.0 over
// TCP (newline-delimited, like port 1705) plus a tiny HTTP server for the
// image cache. It implements every Control API method SnapcastCtrl uses and
// sends notifications to the *other* connected sessions, as snapserver does.
//
//   deno run --allow-net --allow-read tests/tools/mock_snapserver.ts [rpcPort] [httpPort]
//
// From tests: `const mock = await MockSnapserver.start()`.

const FIXTURE = new URL("../fixtures/status.json", import.meta.url)

// 1x1 transparent PNG.
export const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
)

type Json = Record<string, unknown>

interface Session {
  conn: Deno.Conn
  authed: boolean
  chain: Promise<void>
}

/** Queue a full write on the session (writes never interleave or truncate). */
function writeAll(s: Session, bytes: Uint8Array): void {
  s.chain = s.chain.then(async () => {
    let off = 0
    while (off < bytes.length) off += await s.conn.write(bytes.subarray(off))
  }).catch(() => {})
}

export interface MockOptions {
  rpcPort?: number
  httpPort?: number
  /** Require Server.Authenticate with this user:password before anything else. */
  auth?: { user: string; password: string }
  status?: Json
}

export class MockSnapserver {
  state: Json
  sessions = new Set<Session>()
  received: Json[] = []
  rpcPort = 0
  httpPort = 0
  /** Delay responses to these methods (ms), to test timeouts. */
  delays: Record<string, number> = {}
  #listener: Deno.Listener | null = null
  #http: Deno.HttpServer | null = null
  #opts: MockOptions
  #encoder = new TextEncoder()

  constructor(opts: MockOptions) {
    this.#opts = opts
    this.state = structuredClone(opts.status ?? JSON.parse(Deno.readTextFileSync(FIXTURE)).server)
  }

  static start(opts: MockOptions = {}): Promise<MockSnapserver> {
    const m = new MockSnapserver(opts)
    m.listen()
    return Promise.resolve(m)
  }

  listen(): void {
    this.#listener = Deno.listen({ hostname: "127.0.0.1", port: this.#opts.rpcPort ?? 0 })
    this.rpcPort = (this.#listener.addr as Deno.NetAddr).port
    this.#http = Deno.serve({ hostname: "127.0.0.1", port: this.#opts.httpPort ?? 0, onListen: () => {} }, (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/__image_cache") {
        return new Response(PNG_1PX, { headers: { "content-type": "image/png" } })
      }
      if (url.pathname === "/big.png") return new Response(new Uint8Array(5 * 1024 * 1024))
      if (url.pathname === "/not-image.png") return new Response("<html>nope</html>", { headers: { "content-type": "image/png" } })
      return new Response("not found", { status: 404 })
    })
    this.httpPort = (this.#http.addr as Deno.NetAddr).port
    this.#accept()
  }

  async #accept(): Promise<void> {
    const listener = this.#listener!
    try {
      for await (const conn of listener) {
        const s: Session = { conn, authed: !this.#opts.auth, chain: Promise.resolve() }
        this.sessions.add(s)
        this.#serve(s)
      }
    } catch { /* closed */ }
  }

  async #serve(s: Session): Promise<void> {
    const decoder = new TextDecoder()
    const buf = new Uint8Array(64 * 1024)
    let pending = ""
    try {
      for (;;) {
        const n = await s.conn.read(buf)
        if (n === null) break
        pending += decoder.decode(buf.subarray(0, n), { stream: true })
        let nl
        while ((nl = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          if (line) await this.#handleLine(s, line)
        }
      }
    } catch { /* connection reset */ }
    this.sessions.delete(s)
    try {
      s.conn.close()
    } catch { /* closed */ }
  }

  async #handleLine(s: Session, line: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.#write(s, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      return
    }
    if (Array.isArray(msg)) {
      const out: Json[] = []
      const notes: Json[] = []
      for (const m of msg) {
        const r = await this.#handle(s, m as Json)
        out.push(r.response)
        if (r.notification) notes.push(r.notification)
      }
      this.#write(s, out)
      if (notes.length > 0) this.broadcast(notes, s)
      return
    }
    const r = await this.#handle(s, msg as Json)
    this.#write(s, r.response)
    if (r.notification) this.broadcast(r.notification, s)
  }

  #write(s: Session, obj: unknown): void {
    writeAll(s, this.#encoder.encode(JSON.stringify(obj) + "\r\n"))
  }

  /** Send a notification to every session except `except`. */
  broadcast(obj: unknown, except?: Session): void {
    for (const s of this.sessions) if (s !== except) this.#write(s, obj)
  }

  /** Push a notification to all sessions (tests simulating another controller). */
  notify(method: string, params: Json): void {
    this.broadcast({ jsonrpc: "2.0", method, params })
  }

  /** A new snapclient connects: it joins the first group and Client.OnConnect goes out. */
  connectClient(id: string, name = ""): Json {
    const c: Json = {
      id,
      connected: true,
      config: { instance: 1, latency: 0, name, volume: { muted: false, percent: 100 } },
      host: { arch: "x86_64", ip: "127.0.0.1", mac: "00:00:00:00:00:00", name: "localhost", os: "Arch Linux" },
      lastSeen: { sec: 1763000000, usec: 0 },
      snapclient: { name: "Snapclient", protocolVersion: 2, version: "0.35.0" },
    }
    ;(this.groups()[0].clients as Json[]).push(c)
    this.notify("Client.OnConnect", { id, client: c })
    return c
  }

  /** Raw bytes to every session (protocol abuse tests). */
  sendRaw(text: string): void {
    for (const s of this.sessions) writeAll(s, this.#encoder.encode(text))
  }

  dropAll(): void {
    for (const s of this.sessions) {
      try {
        s.conn.close()
      } catch { /* closed */ }
    }
    this.sessions.clear()
  }

  async close(): Promise<void> {
    this.dropAll()
    try {
      this.#listener?.close()
    } catch { /* closed */ }
    await this.#http?.shutdown()
  }

  // ---- state helpers ----
  groups(): Json[] {
    return this.state.groups as Json[]
  }
  streams(): Json[] {
    return this.state.streams as Json[]
  }
  client(id: string): Json | null {
    for (const g of this.groups()) for (const c of g.clients as Json[]) if (c.id === id) return c
    return null
  }
  group(id: string): Json | null {
    return this.groups().find((g) => g.id === id) ?? null
  }
  stream(id: string): Json | null {
    return this.streams().find((st) => st.id === id) ?? null
  }

  async #handle(s: Session, m: Json): Promise<{ response: Json; notification?: Json }> {
    this.received.push(m)
    const id = m.id
    const p = (m.params ?? {}) as Json
    const ok = (result: unknown, notification?: Json) => ({ response: { jsonrpc: "2.0", id, result }, notification })
    const err = (code: number, message: string) => ({ response: { jsonrpc: "2.0", id, error: { code, message } } })
    const note = (method: string, params: Json) => ({ jsonrpc: "2.0", method, params })
    const method = String(m.method)
    if (this.delays[method]) await new Promise((r) => setTimeout(r, this.delays[method]))

    if (method === "Server.Authenticate") {
      const a = this.#opts.auth
      if (!a) return ok("ok")
      const expected = btoa(a.user + ":" + a.password)
      if (p.scheme === "Basic" && p.param === expected) {
        s.authed = true
        return ok("ok")
      }
      return err(401, "Unauthorized")
    }
    if (!s.authed) return err(401, "Unauthorized")

    switch (method) {
      case "Server.GetRPCVersion":
        return ok({ major: 2, minor: 0, patch: 0 })
      case "Server.GetStatus":
        return ok({ server: structuredClone(this.state) })
      case "Server.DeleteClient": {
        for (const g of this.groups()) g.clients = (g.clients as Json[]).filter((c) => c.id !== p.id)
        this.state.groups = this.groups().filter((g) => (g.clients as Json[]).length > 0)
        return ok({ server: structuredClone(this.state) }, note("Server.OnUpdate", { server: structuredClone(this.state) }))
      }
      case "Client.GetStatus": {
        const c = this.client(String(p.id))
        return c ? ok({ client: c }) : err(-32603, "Client not found")
      }
      case "Client.SetVolume": {
        const c = this.client(String(p.id))
        if (!c) return err(-32603, "Client not found")
        const v = p.volume as Json
        const cfg = c.config as Json
        cfg.volume = { percent: Number(v.percent), muted: v.muted === true }
        return ok({ volume: cfg.volume }, note("Client.OnVolumeChanged", { id: p.id, volume: cfg.volume }))
      }
      case "Client.SetLatency": {
        const c = this.client(String(p.id))
        if (!c) return err(-32603, "Client not found")
        ;(c.config as Json).latency = p.latency
        return ok({ latency: p.latency }, note("Client.OnLatencyChanged", { id: p.id, latency: p.latency }))
      }
      case "Client.SetName": {
        const c = this.client(String(p.id))
        if (!c) return err(-32603, "Client not found")
        ;(c.config as Json).name = p.name
        return ok({ name: p.name }, note("Client.OnNameChanged", { id: p.id, name: p.name }))
      }
      case "Group.GetStatus": {
        const g = this.group(String(p.id))
        return g ? ok({ group: g }) : err(-32603, "Group not found")
      }
      case "Group.SetMute": {
        const g = this.group(String(p.id))
        if (!g) return err(-32603, "Group not found")
        g.muted = p.mute === true
        return ok({ mute: g.muted }, note("Group.OnMute", { id: p.id, mute: g.muted }))
      }
      case "Group.SetStream": {
        const g = this.group(String(p.id))
        if (!g) return err(-32603, "Group not found")
        if (!this.stream(String(p.stream_id))) return err(-32603, "Stream not found")
        g.stream_id = p.stream_id
        return ok({ stream_id: p.stream_id }, note("Group.OnStreamChanged", { id: p.id, stream_id: p.stream_id }))
      }
      case "Group.SetName": {
        const g = this.group(String(p.id))
        if (!g) return err(-32603, "Group not found")
        g.name = p.name
        return ok({ name: p.name }, note("Group.OnNameChanged", { id: p.id, name: p.name }))
      }
      case "Group.SetClients": {
        const g = this.group(String(p.id))
        if (!g) return err(-32603, "Group not found")
        const wanted = ((p.clients as string[]) ?? []).map(String)
        const removed = (g.clients as Json[]).filter((c) => !wanted.includes(String(c.id)))
        const members = wanted.map((cid) => this.client(cid)).filter((c): c is Json => c !== null)
        for (const other of this.groups()) {
          other.clients = (other.clients as Json[]).filter((c) => !wanted.includes(String(c.id)))
        }
        // Clients taken out of g get a group of their own, as snapserver does.
        g.clients = members
        for (const c of removed) {
          this.groups().push({ id: crypto.randomUUID(), name: "", muted: false, stream_id: g.stream_id, clients: [c] })
        }
        this.state.groups = this.groups().filter((x) => (x.clients as Json[]).length > 0)
        return ok({ server: structuredClone(this.state) }, note("Server.OnUpdate", { server: structuredClone(this.state) }))
      }
      case "Stream.Control": {
        const st = this.stream(String(p.id))
        if (!st) return err(-32603, "Stream not found")
        const props = st.properties as Json
        if (!props.canControl) return err(1, "Stream can not be controlled")
        const cmd = String(p.command)
        if (cmd === "play") props.playbackStatus = "playing"
        else if (cmd === "pause") props.playbackStatus = "paused"
        else if (cmd === "playPause") props.playbackStatus = props.playbackStatus === "playing" ? "paused" : "playing"
        else if (cmd === "stop") props.playbackStatus = "stopped"
        else if (cmd === "seek") props.position = Number(props.position ?? 0) + Number((p.params as Json)?.offset ?? 0)
        else if (cmd === "setPosition") props.position = Number((p.params as Json)?.position ?? 0)
        else if (cmd !== "next" && cmd !== "previous") return err(-32602, "Command not supported")
        // Properties notifications go to everyone, like snapserver's plugin updates.
        setTimeout(() => this.broadcast(note("Stream.OnProperties", { id: p.id, properties: structuredClone(props) })), 5)
        return ok("ok")
      }
      case "Stream.SetProperty": {
        const st = this.stream(String(p.id))
        if (!st) return err(-32603, "Stream not found")
        const props = st.properties as Json
        props[String(p.property)] = p.value
        setTimeout(() => this.broadcast(note("Stream.OnProperties", { id: p.id, properties: structuredClone(props) })), 5)
        return ok("ok")
      }
      case "Stream.AddStream": {
        const uri = String(p.streamUri ?? "")
        let u: URL
        try {
          u = new URL(uri)
        } catch {
          return err(-32602, "Invalid stream URI")
        }
        const name = u.searchParams.get("name") ?? ""
        if (!name) return err(-32603, "Stream name must not be empty")
        if (this.stream(name)) return err(-32603, "Stream with name '" + name + "' already exists")
        const query: Json = {}
        u.searchParams.forEach((v, k) => (query[k] = v))
        this.streams().push({
          id: name,
          status: "idle",
          uri: { raw: uri, scheme: u.protocol.replace(":", ""), host: u.host, path: decodeURIComponent(u.pathname), fragment: "", query },
          properties: { canControl: false, canGoNext: false, canGoPrevious: false, canPause: false, canPlay: false, canSeek: false },
        })
        return ok({ id: name }, note("Server.OnUpdate", { server: structuredClone(this.state) }))
      }
      case "Stream.RemoveStream": {
        if (!this.stream(String(p.id))) return err(-32603, "Stream not found")
        this.state.streams = this.streams().filter((st) => st.id !== p.id)
        return ok({ id: p.id }, note("Server.OnUpdate", { server: structuredClone(this.state) }))
      }
      default:
        return err(-32601, "Method not found")
    }
  }
}

if (import.meta.main) {
  const rpcPort = Number(Deno.args[0] ?? 1705)
  const httpPort = Number(Deno.args[1] ?? 1780)
  const m = await MockSnapserver.start({ rpcPort, httpPort })
  // Point the fixture's image-cache URL at this HTTP port.
  const spotify = m.stream("Spotify")
  if (spotify) {
    const meta = (spotify.properties as Json).metadata as Json
    meta.artUrl = "http://127.0.0.1:" + m.httpPort + "/__image_cache?name=abc123.png"
  }
  console.log("mock snapserver: rpc 127.0.0.1:" + m.rpcPort + ", http 127.0.0.1:" + m.httpPort)
}
