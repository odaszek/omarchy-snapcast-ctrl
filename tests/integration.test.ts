// End to end: the real helper, started through start.sh with its real
// permission set, talking NDJSON on stdio and JSON-RPC to the mock server.
// A fake snapclient script stands in for local playback.

import { MockSnapserver } from "./tools/mock_snapserver.ts"
import { assert, assertEquals, assertMatch, waitFor } from "./_assert.ts"

const START = new URL("../helper/start.sh", import.meta.url).pathname

const KITCHEN = "b8:27:eb:45:e1:ae"
const LIVING = "dc:a6:32:3f:bd:1c"
const OFFICE = "74:da:38:3e:d2:56"
const G1 = "4dcc4e3b-c699-a04b-7f0c-8260d23c43e1"
const G2 = "1d5d515b-d5c0-2831-6415-c85225c4315f"

type Msg = Record<string, unknown>
// deno-lint-ignore no-explicit-any
type Server = any

class Helper {
  child: Deno.ChildProcess
  events: Msg[] = []
  replies = new Map<number, Msg>()
  #nextId = 1
  #writer: WritableStreamDefaultWriter<Uint8Array>
  #done: Promise<void>
  stderr = ""

  constructor(stateDir: string, netAllow: string, snapclient: string, args: string[]) {
    this.child = new Deno.Command("bash", {
      args: [START, stateDir, netAllow, snapclient, ...args],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
    this.#writer = this.child.stdin.getWriter()
    this.#done = this.#read()
    this.#readErr()
  }

  async #read() {
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of this.child.stdout) {
      buf += dec.decode(chunk, { stream: true })
      let nl
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const msg = JSON.parse(line) as Msg
        if (msg.event) this.events.push(msg)
        else this.replies.set(Number(msg.id), msg)
      }
    }
  }

  async #readErr() {
    const dec = new TextDecoder()
    for await (const chunk of this.child.stderr) this.stderr += dec.decode(chunk)
  }

  async call(op: string, params: Msg = {}): Promise<Msg> {
    const id = this.#nextId++
    await this.#writer.write(new TextEncoder().encode(JSON.stringify({ ...params, id, op }) + "\n"))
    return (await waitFor(() => this.replies.get(id), 5000, "reply to " + op)) as Msg
  }

  async ok(op: string, params: Msg = {}): Promise<Msg> {
    const r = await this.call(op, params)
    if (r.ok !== true) throw new Error(op + " failed: " + r.error)
    return r.result as Msg
  }

  last(event: string): Msg | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].event === event) return this.events[i]
    return undefined
  }

  server(): Server {
    return this.last("status")?.server
  }

  waitServer(pred: (s: Server) => boolean, what: string): Promise<Server> {
    return waitFor(
      () => {
        const s = this.server()
        return s && pred(s) ? s : null
      },
      5000,
      what,
    )
  }

  async close() {
    try {
      await this.#writer.close()
    } catch { /* closed */ }
    const st = await this.child.status
    await this.#done.catch(() => {})
    return st
  }
}

function client(s: Server, id: string) {
  for (const g of s.groups) for (const c of g.clients) if (c.id === id) return c
  return null
}
function group(s: Server, id: string) {
  return s.groups.find((g: { id: string }) => g.id === id)
}

async function fakeSnapclient(dir: string): Promise<{ bin: string; argsFile: string; crashFile: string }> {
  const bin = dir + "/snapclient"
  const argsFile = dir + "/args.log"
  const crashFile = dir + "/crash"
  await Deno.writeTextFile(
    bin,
    `#!/bin/bash
case "$1" in
  --version) echo "snapclient v0.35.0"; exit 0 ;;
esac
for a in "$@"; do [[ $a == --list ]] && { printf '0: null\\nDiscard all samples\\n\\n1: default\\nDefault Output\\n'; exit 0; }; done
printf '%s\\n' "$*" >> ${argsFile}
[[ -e ${crashFile} ]] && { echo "error: cannot open device" >&2; exit 1; }
trap 'exit 0' TERM
while :; do sleep 0.05; done
`,
    { mode: 0o755 },
  )
  return { bin, argsFile, crashFile }
}

async function setup(opts: { auth?: { user: string; password: string } } = {}) {
  const mock = await MockSnapserver.start(opts)
  const dir = await Deno.makeTempDir()
  const fake = await fakeSnapclient(dir)
  const helper = new Helper(dir + "/state", `127.0.0.1:${mock.rpcPort},127.0.0.1:${mock.httpPort}`, fake.bin, [
    "--host",
    "127.0.0.1",
    "--port",
    String(mock.rpcPort),
    "--http-port",
    String(mock.httpPort),
    "--stream-port",
    "1704",
  ])
  const cleanup = async () => {
    await helper.close()
    await mock.close()
    await Deno.remove(dir, { recursive: true })
  }
  return { mock, dir, fake, helper, cleanup }
}

Deno.test({
  name: "helper: connects, reports status, applies every client/group operation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mock, helper, cleanup } = await setup()
    try {
      await waitFor(() => helper.last("ready"), 5000, "ready")
      await waitFor(() => helper.last("connection")?.state === "connected", 5000, "connected")
      assertEquals(helper.last("connection")?.rpcVersion, "2.0.0")
      let s = await helper.waitServer((s) => s.groups.length === 2, "initial status")
      assertEquals(s.server.snapserver.version, "0.35.0")

      // Client volume + mute (coalesced; the last value wins).
      for (const p of [10, 20, 30, 33]) await helper.ok("setClientVolume", { clientId: KITCHEN, percent: p })
      await helper.ok("setClientVolume", { clientId: KITCHEN, muted: true })
      await waitFor(
        () => {
          const c = mock.client(KITCHEN) as Msg
          const v = (c.config as Msg).volume as Msg
          return v.percent === 33 && v.muted === true
        },
        3000,
        "server volume",
      )
      s = await helper.waitServer((s) => client(s, KITCHEN).config.volume.muted === true, "local volume")
      assertEquals(client(s, KITCHEN).config.volume.percent, 33)
      const sent = mock.received.filter((m) => m.method === "Client.SetVolume").length
      assert(sent <= 5, "volume requests coalesced (" + sent + ")")

      // Group volume via setVolumes.
      await helper.ok("setVolumes", { volumes: [{ id: KITCHEN, percent: 5 }, { id: LIVING, percent: 6 }] })
      await waitFor(
        () => ((mock.client(LIVING) as Msg).config as Msg as { volume: { percent: number } }).volume.percent === 6,
        3000,
        "group volume",
      )

      // Name and latency.
      await helper.ok("setClientName", { clientId: KITCHEN, name: "  Küche  " })
      await helper.ok("setClientLatency", { clientId: KITCHEN, latency: 42 })
      s = await helper.waitServer(
        (s) => client(s, KITCHEN).config.name === "Küche" && client(s, KITCHEN).config.latency === 42,
        "name+latency",
      )

      // Group mute, name, stream.
      await helper.ok("setGroupMute", { groupId: G1, mute: true })
      await helper.ok("setGroupName", { groupId: G1, name: "Downstairs" })
      await helper.ok("setGroupStream", { groupId: G1, streamId: "Spotify" })
      s = await helper.waitServer((s) => {
        const g = group(s, G1)
        return g.muted && g.name === "Downstairs" && g.stream_id === "Spotify"
      }, "group changes")
      assertEquals((mock.group(G1) as Msg).stream_id, "Spotify")
      const bad = await helper.call("setGroupStream", { groupId: G1, streamId: "nope" })
      assertEquals(bad.ok, false)

      // Move a client between groups.
      await helper.ok("setGroupClients", { groupId: G2, clients: [OFFICE, LIVING] })
      s = await helper.waitServer((s) => group(s, G2)?.clients.length === 2, "regroup")
      assertEquals(group(s, G1).clients.map((c: Msg) => c.id), [KITCHEN])

      // Delete a client.
      await helper.ok("deleteClient", { clientId: OFFICE })
      s = await helper.waitServer((s) => client(s, OFFICE) === null, "deleted")

      // Validation.
      assertEquals((await helper.call("setClientVolume", { clientId: "" })).ok, false)
      assertEquals((await helper.call("setClientVolume", { clientId: "zz" })).ok, false)
      assertEquals((await helper.call("nope")).ok, false)
    } finally {
      await cleanup()
    }
  },
})

Deno.test({
  name: "helper: stream control, properties, add/remove streams, cover art",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mock, helper, dir, cleanup } = await setup()
    try {
      const sp = mock.stream("Spotify") as Msg
      ;((sp.properties as Msg).metadata as Msg).artUrl = "http://raspberrypi:1780/__image_cache?name=x.png"
      await helper.waitServer((s) => s.streams.length === 2, "status")

      await helper.ok("streamControl", { streamId: "Spotify", command: "play" })
      let s = await helper.waitServer((s) => s.streams[1].properties.playbackStatus === "playing", "playing")
      await helper.ok("streamControl", { streamId: "Spotify", command: "seek", params: { offset: 10 } })
      await helper.ok("streamControl", { streamId: "Spotify", command: "setPosition", params: { position: 3 } })
      s = await helper.waitServer((s) => s.streams[1].properties.position === 3, "position")
      assertEquals(s.streams[1].properties.metadata.title, "Close Your Eyes")
      assertEquals((await helper.call("streamControl", { streamId: "Spotify", command: "rm -rf" })).ok, false)
      assertEquals((await helper.call("streamControl", { streamId: "default", command: "play" })).ok, false, "canControl=false")
      assertEquals((await helper.call("streamControl", { streamId: "Spotify", command: "seek", params: { offset: "x" } })).ok, false)

      await helper.ok("streamSetProperty", { streamId: "Spotify", property: "shuffle", value: true })
      await helper.ok("streamSetProperty", { streamId: "Spotify", property: "loopStatus", value: "track" })
      s = await helper.waitServer((s) => s.streams[1].properties.shuffle && s.streams[1].properties.loopStatus === "track", "props")
      assertEquals((await helper.call("streamSetProperty", { streamId: "Spotify", property: "loopStatus", value: "evil" })).ok, false)
      assertEquals((await helper.call("streamSetProperty", { streamId: "Spotify", property: "controlscript", value: "x" })).ok, false)

      // Cover art comes from the server's image cache, rewritten to the configured host.
      s = await helper.waitServer((s) => s.streams[1].artFile !== "", "art file")
      assertMatch(s.streams[1].artFile, new RegExp("^" + dir + "/state/art/[0-9a-f]{64}\\.png$"))

      // Add and remove a stream.
      const added = await helper.ok("addStream", { spec: { type: "pipe", name: "Test pipe", path: "/tmp/snapctrl-test", mode: "create" } })
      assertEquals(added, { added: true, streamId: "Test pipe" })
      s = await helper.waitServer((s) => s.streams.length === 3, "added")
      const raw = (mock.stream("Test pipe") as Msg).uri as Msg
      assertEquals(raw.raw, "pipe:///tmp/snapctrl-test?name=Test%20pipe&mode=create")
      const invalid = await helper.ok("addStream", { spec: { type: "process", name: "x", path: "/bin/sh" } })
      assertEquals(invalid.added, false)
      const dup = await helper.call("addStream", { spec: { type: "pipe", name: "Test pipe", path: "/tmp/x" } })
      assertEquals(dup.ok, false)
      assertMatch(String(dup.error), /already exists/)
      await helper.ok("removeStream", { streamId: "Test pipe" })
      await helper.waitServer((s) => s.streams.length === 2, "removed")
    } finally {
      await cleanup()
    }
  },
})

Deno.test({
  name: "helper: follows notifications from other controllers and survives a server restart",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { mock, helper, cleanup } = await setup()
    try {
      await helper.waitServer((s) => s.groups.length === 2, "status")
      mock.notify("Client.OnVolumeChanged", { id: LIVING, volume: { percent: 3, muted: false } })
      mock.notify("Group.OnNameChanged", { id: G2, name: "<img src=http://evil/x>‮" })
      let s = await helper.waitServer((s) => client(s, LIVING).config.volume.percent === 3 && group(s, G2).name !== "", "notes")
      assertEquals(group(s, G2).name, "<img src=http://evil/x>", "bidi override stripped; markup is neutralised in QML")

      // A notification about an unknown client triggers a full refresh.
      const before = mock.received.filter((m) => m.method === "Server.GetStatus").length
      mock.notify("Client.OnVolumeChanged", { id: "unknown", volume: { percent: 1 } })
      await waitFor(() => mock.received.filter((m) => m.method === "Server.GetStatus").length > before, 3000, "refresh")

      mock.dropAll()
      await waitFor(() => helper.last("connection")?.state === "disconnected", 3000, "disconnected")
      s = helper.server()
      assertEquals(s.groups.length, 0, "stale state cleared while disconnected")
      await waitFor(() => helper.last("connection")?.state === "connected", 5000, "reconnected")
      await helper.waitServer((s) => s.groups.length === 2, "status after reconnect")
      const r = await helper.call("reconnect")
      assertEquals(r.ok, true)
    } finally {
      await cleanup()
    }
  },
})

Deno.test({
  name: "helper: authentication failure is reported",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { helper, cleanup } = await setup({ auth: { user: "u", password: "p" } })
    try {
      await waitFor(
        () => {
          const c = helper.last("connection")
          return c && c.state === "disconnected" && /authentication required/.test(String(c.error))
        },
        5000,
        "auth error",
      )
      const r = await helper.call("setClientVolume", { clientId: KITCHEN, percent: 1 })
      assertEquals(r.ok, false)
      assertMatch(String(r.error), /not connected/)
    } finally {
      await cleanup()
    }
  },
})

Deno.test({
  name: "helper: local playback starts, restarts on crash and stops snapclient",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { helper, fake, cleanup } = await setup()
    try {
      const st = await helper.ok("localStatus")
      assertEquals([st.available, st.version, st.state], [true, "0.35.0", "stopped"])
      const cards = await helper.ok("listSoundcards", { player: "alsa" })
      assertEquals((cards.soundcards as Msg[]).map((c) => c.value), ["null", "default"])

      await helper.ok("localStart", { player: "pulse", soundcard: "", latency: 25, hostId: "omarchy-test" })
      await waitFor(() => helper.last("local")?.state === "running", 5000, "running")
      const argv = (await Deno.readTextFile(fake.argsFile)).trim()
      assertEquals(argv, "--hostID omarchy-test --player pulse --logsink stderr --latency 25 tcp://127.0.0.1:1704")
      assertEquals((await helper.ok("localClientId", { hostId: "omarchy-test" })).clientId, "omarchy-test")

      // Crash → restart with backoff.
      await Deno.writeTextFile(fake.crashFile, "")
      await Deno.writeTextFile(fake.argsFile, "")
      // Restart with new options to force a respawn that crashes.
      await helper.ok("localStart", { player: "pulse", soundcard: "", latency: 0, hostId: "omarchy-test" })
      await waitFor(() => helper.last("local")?.state === "restarting", 5000, "restarting")
      assertMatch(String(helper.last("local")?.error), /cannot open device/)
      await Deno.remove(fake.crashFile)
      await waitFor(() => helper.last("local")?.state === "running", 8000, "running again")

      const bad = await helper.call("localStart", { player: "evil", hostId: "x y" })
      assertEquals(bad.ok, true, "invalid options fall back to defaults")

      await helper.ok("localStop")
      assertEquals(helper.last("local")?.state, "stopped")
      const ps = await new Deno.Command("pgrep", { args: ["-f", fake.bin + " --hostID"], stdout: "piped" }).output()
      assertEquals(new TextDecoder().decode(ps.stdout).trim(), "", "no snapclient left running")
    } finally {
      await cleanup()
    }
  },
})

Deno.test({
  name: "helper: exits on stdin EOF and kills snapclient",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { helper, fake, mock, dir } = await setup()
    try {
      await helper.ok("localStart", { player: "pulse", hostId: "omarchy-eof" })
      await waitFor(() => helper.last("local")?.state === "running", 5000, "running")
      const st = await helper.close()
      assertEquals(st.code, 0)
      await waitFor(
        async () => {
          const ps = await new Deno.Command("pgrep", { args: ["-f", fake.bin + " --hostID omarchy-eof"], stdout: "piped" }).output()
          return new TextDecoder().decode(ps.stdout).trim() === ""
        },
        5000,
        "snapclient gone",
      )
    } finally {
      await mock.close()
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: "helper: the network permission blocks other hosts",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mock = await MockSnapserver.start()
    const other = await MockSnapserver.start()
    const dir = await Deno.makeTempDir()
    // Allowed: only `other`'s port. The helper is told to use `mock` → denied.
    const helper = new Helper(dir + "/state", `127.0.0.1:${other.rpcPort}`, "snapclient", [
      "--host",
      "127.0.0.1",
      "--port",
      String(mock.rpcPort),
    ])
    try {
      await waitFor(
        () => {
          const c = helper.last("connection")
          return c && c.state === "disconnected" && /net access|NotCapable|permission/i.test(String(c.error))
        },
        5000,
        "permission denied",
      )
      assertEquals(mock.received.length, 0)
    } finally {
      await helper.close()
      await mock.close()
      await other.close()
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: "helper: unconfigured server reports state and makes no connection",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir()
    const helper = new Helper(dir + "/state", "", "snapclient", [])
    try {
      await waitFor(() => helper.last("connection")?.state === "unconfigured", 5000, "unconfigured")
      assertEquals((await helper.call("localStart", {})).ok, false)
    } finally {
      await helper.close()
      await Deno.remove(dir, { recursive: true })
    }
  },
})
