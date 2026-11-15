// Unit tests for lib/model.mjs: normalization, the notification reducer,
// group volume math, stream URI building, settings and snapclient argv.

import * as M from "../lib/model.mjs"
import { assert, assertEquals, assertThrows } from "./_assert.ts"

const fixture = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/status.json", import.meta.url)))
const base = () => M.normalizeServer(fixture)

const KITCHEN = "b8:27:eb:45:e1:ae"
const LIVING = "dc:a6:32:3f:bd:1c"
const OFFICE = "74:da:38:3e:d2:56"
const G1 = "4dcc4e3b-c699-a04b-7f0c-8260d23c43e1"
const G2 = "1d5d515b-d5c0-2831-6415-c85225c4315f"

// ---------------------------------------------------------------- normalize

Deno.test("normalizeServer accepts both {server:{…}} and the bare server object", () => {
  const a = M.normalizeServer(fixture)
  const b = M.normalizeServer(fixture.server)
  assertEquals(a, b)
  assertEquals(a.groups.length, 2)
  assertEquals(a.streams.map((s: { id: string }) => s.id), ["default", "Spotify"])
  assertEquals(a.server.snapserver.version, "0.35.0")
})

Deno.test("normalizeServer survives junk", () => {
  for (const junk of [null, undefined, 42, "x", [], { groups: "nope" }, { groups: [null, 1, {}] }]) {
    const s = M.normalizeServer(junk)
    assertEquals(s.groups.length, 0)
    assertEquals(s.streams.length, 0)
  }
})

Deno.test("normalizeClient clamps volume and strips control characters", () => {
  const c = M.normalizeClient({
    id: "x",
    config: { name: "a\u0000b\u001bc\nd", volume: { percent: 250, muted: "yes" }, latency: 1e9 },
  })
  assertEquals(c.config.name, "abcd")
  assertEquals(c.config.volume, { percent: 100, muted: false })
  assertEquals(c.config.latency, 10000)
})

Deno.test("normalizeServer bounds strings and collections", () => {
  const long = "x".repeat(10000)
  const clients = Array.from({ length: 500 }, (_, i) => ({ id: "c" + i, config: { name: long } }))
  const s = M.normalizeServer({ groups: [{ id: "g", clients }], streams: Array.from({ length: 500 }, (_, i) => ({ id: "s" + i })) })
  assertEquals(s.groups[0].clients.length, M.LIMITS.clientsPerGroup)
  assertEquals(s.groups[0].clients[0].config.name.length, M.LIMITS.name)
  assertEquals(s.streams.length, M.LIMITS.streams)
})

Deno.test("normalizeServer drops duplicate client and stream ids", () => {
  const s = M.normalizeServer({
    groups: [{ id: "g1", clients: [{ id: "a" }] }, { id: "g2", clients: [{ id: "a" }, { id: "b" }] }],
    streams: [{ id: "s" }, { id: "s" }],
  })
  assertEquals(M.allClients(s).map((c: { id: string }) => c.id), ["a", "b"])
  assertEquals(s.streams.length, 1)
})

Deno.test("metadata artist accepts a string or a list", () => {
  assertEquals(M.normalizeMetadata({ artist: "Solo" }).artist, ["Solo"])
  assertEquals(M.normalizeMetadata({ artist: ["A", 3, null, "B"] }).artist, ["A", "3", "B"])
})

// ------------------------------------------------------------------ lookups

Deno.test("clientName falls back to host name, groupName to members", () => {
  const s = base()
  assertEquals(M.clientName(M.findClient(s, KITCHEN)), "Kitchen")
  assertEquals(M.clientName(M.findClient(s, LIVING)), "livingroom")
  assertEquals(M.groupName(M.findGroup(s, G1)), "Kitchen, livingroom")
  assertEquals(M.groupName(M.findGroup(s, G2)), "Office")
})

Deno.test("visibleGroups hides groups whose clients are all offline", () => {
  const s = base()
  assertEquals(M.visibleGroups(s, false).length, 2)
  assertEquals(M.visibleGroups(s, true).map((g: { id: string }) => g.id), [G1])
})

Deno.test("groupVolume averages (optionally online-only)", () => {
  const s = base()
  assertEquals(M.groupVolume(M.findGroup(s, G1), false), 60)
  assertEquals(M.groupVolume(M.findGroup(s, G2), true), 0)
  assertEquals(M.groupVolume(null, false), 0)
})

// ---------------------------------------------------------- group volume math

Deno.test("groupVolumeTargets lowers proportionally", () => {
  const t = M.groupVolumeTargets([{ id: "a", percent: 40 }, { id: "b", percent: 80 }], 30)
  // avg 60 → 30 is ratio 0.5: 40→20, 80→40
  assertEquals(t, [{ id: "a", percent: 20 }, { id: "b", percent: 40 }])
})

Deno.test("groupVolumeTargets raises by closing headroom", () => {
  const t = M.groupVolumeTargets([{ id: "a", percent: 40 }, { id: "b", percent: 80 }], 80)
  // avg 60 → 80 closes half the headroom: 40→70, 80→90
  assertEquals(t, [{ id: "a", percent: 70 }, { id: "b", percent: 90 }])
})

Deno.test("groupVolumeTargets edge cases: 0, 100, empty, all zero", () => {
  assertEquals(M.groupVolumeTargets([], 50), [])
  assertEquals(M.groupVolumeTargets([{ id: "a", percent: 40 }, { id: "b", percent: 80 }], 0), [
    { id: "a", percent: 0 },
    { id: "b", percent: 0 },
  ])
  assertEquals(M.groupVolumeTargets([{ id: "a", percent: 40 }, { id: "b", percent: 80 }], 100), [
    { id: "a", percent: 100 },
    { id: "b", percent: 100 },
  ])
  assertEquals(M.groupVolumeTargets([{ id: "a", percent: 0 }], 50), [{ id: "a", percent: 50 }])
  assertEquals(M.groupVolumeTargets([{ id: "a", percent: 100 }], 100), [{ id: "a", percent: 100 }])
  assertEquals(M.groupVolumeTargets([{ id: "a", percent: 0 }], 0), [{ id: "a", percent: 0 }])
})

// ------------------------------------------------------------------- reducer

function reduce(server: unknown, method: string, params: unknown) {
  return M.reduce(server, { method, params })
}

Deno.test("reduce: client volume, latency, name", () => {
  let s = base()
  s = reduce(s, "Client.OnVolumeChanged", { id: KITCHEN, volume: { percent: 12, muted: true } }).server
  assertEquals(M.findClient(s, KITCHEN).config.volume, { percent: 12, muted: true })
  s = reduce(s, "Client.OnLatencyChanged", { id: KITCHEN, latency: 35 }).server
  assertEquals(M.findClient(s, KITCHEN).config.latency, 35)
  s = reduce(s, "Client.OnNameChanged", { id: KITCHEN, name: "Küche" }).server
  assertEquals(M.findClient(s, KITCHEN).config.name, "Küche")
})

Deno.test("reduce does not mutate its input", () => {
  const s = base()
  const before = JSON.stringify(s)
  reduce(s, "Client.OnVolumeChanged", { id: KITCHEN, volume: { percent: 1, muted: false } })
  reduce(s, "Group.OnMute", { id: G1, mute: true })
  assertEquals(JSON.stringify(s), before)
})

Deno.test("reduce: connect / disconnect replace the client", () => {
  const s = base()
  const off = JSON.parse(JSON.stringify(fixture.server.groups[0].clients[0]))
  off.connected = false
  const r = reduce(s, "Client.OnDisconnect", { id: KITCHEN, client: off })
  assert(r.changed)
  assertEquals(M.findClient(r.server, KITCHEN).connected, false)
})

Deno.test("reduce: an unknown client connecting asks for a refresh", () => {
  const r = reduce(base(), "Client.OnConnect", { id: "new", client: { id: "new", connected: true } })
  assertEquals(r.changed, false)
  assertEquals(r.refresh, true)
})

Deno.test("reduce: unknown ids ask for a refresh and leave the snapshot alone", () => {
  for (
    const [method, params] of [
      ["Client.OnVolumeChanged", { id: "zz", volume: { percent: 1 } }],
      ["Client.OnLatencyChanged", { id: "zz", latency: 1 }],
      ["Client.OnNameChanged", { id: "zz", name: "x" }],
      ["Group.OnMute", { id: "zz", mute: true }],
      ["Group.OnStreamChanged", { id: "zz", stream_id: "x" }],
      ["Group.OnNameChanged", { id: "zz", name: "x" }],
      ["Stream.OnUpdate", { id: "zz", stream: {} }],
      ["Stream.OnProperties", { id: "zz", properties: {} }],
    ] as [string, unknown][]
  ) {
    const s = base()
    const r = reduce(s, method, params)
    assertEquals(r.refresh, true, method)
    assertEquals(r.server, s, method)
  }
})

Deno.test("reduce: group mute, stream, name", () => {
  let s = base()
  s = reduce(s, "Group.OnMute", { id: G1, mute: true }).server
  s = reduce(s, "Group.OnStreamChanged", { id: G1, stream_id: "Spotify" }).server
  s = reduce(s, "Group.OnNameChanged", { id: G1, name: "Downstairs" }).server
  const g = M.findGroup(s, G1)
  assertEquals([g.muted, g.stream_id, g.name], [true, "Spotify", "Downstairs"])
})

Deno.test("reduce: Stream.OnProperties accepts nested properties and keeps old metadata", () => {
  let s = base()
  s = reduce(s, "Stream.OnProperties", { id: "Spotify", properties: { playbackStatus: "playing", position: 20 } }).server
  const p = M.findStream(s, "Spotify").properties
  assertEquals(p.playbackStatus, "playing")
  assertEquals(p.position, 20)
  assertEquals(p.metadata.title, "Close Your Eyes", "metadata kept")
  assertEquals(p.canSeek, true, "capabilities kept")
})

Deno.test("reduce: Stream.OnProperties accepts the flat form with metadata", () => {
  const s = reduce(base(), "Stream.OnProperties", { id: "Spotify", metadata: { title: "Next one", artist: "B" } }).server
  const p = M.findStream(s, "Spotify").properties
  assertEquals(p.metadata.title, "Next one")
  assertEquals(p.metadata.artist, ["B"])
  assertEquals(p.playbackStatus, "paused")
})

Deno.test("reduce: Stream.OnUpdate replaces the stream", () => {
  const s = reduce(base(), "Stream.OnUpdate", { id: "default", stream: { id: "default", status: "idle", uri: { raw: "pipe:///x" } } })
    .server
  assertEquals(M.findStream(s, "default").status, "idle")
})

Deno.test("reduce: Server.OnUpdate replaces everything", () => {
  const r = reduce(base(), "Server.OnUpdate", { server: { groups: [], streams: [{ id: "only" }] } })
  assertEquals(r.server.groups.length, 0)
  assertEquals(r.server.streams.map((x: { id: string }) => x.id), ["only"])
})

Deno.test("reduce ignores unknown methods and junk", () => {
  const s = base()
  for (const n of [null, {}, { method: 5 }, { method: "Foo.Bar", params: {} }]) {
    const r = M.reduce(s, n)
    assertEquals(r.changed, false)
    assertEquals(r.refresh, false)
  }
})

// ------------------------------------------------------------------ controls

Deno.test("controls follow the canX flags", () => {
  const s = base()
  assertEquals(M.controls(M.findStream(s, "default")).any, false)
  const c = M.controls(M.findStream(s, "Spotify"))
  assertEquals(c, { any: true, previous: true, playPause: true, next: true, seek: true, playing: false })
  assertEquals(M.nextLoopStatus("none"), "track")
  assertEquals(M.nextLoopStatus("playlist"), "none")
  assertEquals(M.nextLoopStatus("junk"), "none")
})

Deno.test("targetGroup prefers the local client's group", () => {
  const s = base()
  assertEquals(M.targetGroup(s, OFFICE, false).id, G2)
  assertEquals(M.targetGroup(s, "", false).id, G1)
  assertEquals(M.targetGroup(M.emptyServer(), "", false), null)
  assert(M.anyPlaying(s))
})

// ---------------------------------------------------------------- stream URI

Deno.test("buildStreamUri: pipe", () => {
  const r = M.buildStreamUri({ type: "pipe", name: "Kodi", path: "/tmp/kodi", mode: "create", codec: "flac", sampleformat: "48000:16:2" })
  assertEquals(r.uri, "pipe:///tmp/kodi?name=Kodi&mode=create&codec=flac&sampleformat=48000%3A16%3A2")
})

Deno.test("buildStreamUri: tcp server and client, IPv6", () => {
  assertEquals(M.buildStreamUri({ type: "tcp", name: "In", mode: "server" }).uri, "tcp://0.0.0.0:4953?name=In&mode=server")
  assertEquals(
    M.buildStreamUri({ type: "tcp", name: "In", mode: "client", host: "10.0.0.2", port: 5000 }).uri,
    "tcp://10.0.0.2:5000?name=In&mode=client",
  )
  assertEquals(M.buildStreamUri({ type: "tcp", name: "In", mode: "client", host: "::1", port: 1 }).uri, "tcp://[::1]:1?name=In&mode=client")
  assertEquals(M.buildStreamUri({ type: "tcp", name: "In", mode: "client" }).ok, false)
})

Deno.test("buildStreamUri: alsa, file, meta, librespot, airplay", () => {
  assertEquals(M.buildStreamUri({ type: "alsa", name: "Line", device: "hw:0,1,0" }).uri, "alsa:///?name=Line&device=hw%3A0%2C1%2C0")
  assertEquals(M.buildStreamUri({ type: "file", name: "F", path: "/srv/a.pcm" }).uri, "file:///srv/a.pcm?name=F")
  assertEquals(M.buildStreamUri({ type: "meta", name: "Mix", sources: ["Spotify", "default"] }).uri, "meta:///Spotify/default?name=Mix")
  assertEquals(
    M.buildStreamUri({ type: "librespot", name: "Spot", path: "/usr/bin/librespot", devicename: "Living", bitrate: "320" }).uri,
    "librespot:///usr/bin/librespot?name=Spot&devicename=Living&bitrate=320",
  )
  assertEquals(
    M.buildStreamUri({ type: "airplay", name: "AP", path: "/usr/bin/shairport-sync" }).uri,
    "airplay:///usr/bin/shairport-sync?name=AP",
  )
})

Deno.test("buildStreamUri rejects injection and bad input", () => {
  const bad: Record<string, unknown>[] = [
    { type: "process", name: "x", path: "/bin/sh" },
    { type: "pipe", name: "x&controlscript=/tmp/evil", path: "/tmp/a" },
    { type: "pipe", name: "x", path: "/tmp/a?controlscript=evil" },
    { type: "pipe", name: "x", path: "/tmp/../etc/passwd" },
    { type: "pipe", name: "x", path: "relative" },
    { type: "pipe", name: "x", path: "/tmp/a\n" },
    { type: "pipe", name: "x\nInjected", path: "/tmp/a" },
    { type: "pipe", name: "x", path: "/tmp/a", mode: "write" },
    { type: "pipe", name: "", path: "/tmp/a" },
    { type: "pipe", name: "y".repeat(65), path: "/tmp/a" },
    { type: "pipe", name: "x", path: "/tmp/a", codec: "mp3" },
    { type: "pipe", name: "x", path: "/tmp/a", sampleformat: "48000:16:2&x=y" },
    { type: "pipe", name: "x", path: "/tmp/a", controlscript: "../evil.py" },
    { type: "pipe", name: "x", path: "/tmp/a", controlscript: "/usr/bin/evil" },
    { type: "tcp", name: "x", mode: "client", host: "evil.com/x?y", port: 1 },
    { type: "tcp", name: "x", mode: "client", host: "a.b", port: 70000 },
    { type: "alsa", name: "x", device: "hw:0&controlscript=x" },
    { type: "meta", name: "x", sources: [] },
    { type: "meta", name: "x", sources: ["a/b"] },
    { type: "librespot", name: "x", path: "/usr/bin/librespot", bitrate: "999" },
    { type: "librespot", name: "x", path: "/usr/bin/librespot", devicename: "a&b" },
    { type: "pipe", name: "x", path: "/tmp/" + "a".repeat(2100) },
  ]
  for (const spec of bad) assertEquals(M.buildStreamUri(spec).ok, false, JSON.stringify(spec).slice(0, 80))
  assertEquals(M.buildStreamUri(null).ok, false)
})

Deno.test("buildStreamUri allows a control script file name", () => {
  assertEquals(
    M.buildStreamUri({ type: "pipe", name: "MPD", path: "/tmp/mpd", controlscript: "meta_mpd.py" }).uri,
    "pipe:///tmp/mpd?name=MPD&mode=create&controlscript=meta_mpd.py",
  )
})

Deno.test("validHost", () => {
  for (const h of ["localhost", "snap.lan", "192.168.0.10", "::1", "fe80::1", "a-b.c"]) assert(M.validHost(h), h)
  for (const h of ["", "-x", "a b", "a/b", "999.1.1.1", "x".repeat(300), "a;rm", "http://x"]) assert(!M.validHost(h), h)
})

// ------------------------------------------------------------------ settings

Deno.test("normalizeSettings applies defaults and rejects junk", () => {
  const s = M.normalizeSettings({})
  assertEquals(s.host, "")
  assertEquals([s.port, s.httpPort, s.streamPort], [1705, 1780, 1704])
  assertEquals(s.coverArt, "server")
  assertEquals(s.localPlayer, "pulse")
  const j = M.normalizeSettings({
    host: "a;b",
    port: 0,
    coverArt: "evil",
    localPlayer: "sh",
    localSoundcard: "x$(y)",
    localHostId: "a b",
    username: "a b",
  })
  assertEquals([j.host, j.port, j.coverArt, j.localPlayer, j.localSoundcard, j.localHostId, j.username], [
    "",
    1705,
    "server",
    "pulse",
    "",
    "",
    "",
  ])
  assertEquals(M.normalizeSettings({ host: " snap.lan " }).host, "snap.lan")
})

Deno.test("netAllowList limits the helper to the server", () => {
  assertEquals(M.netAllowList(M.normalizeSettings({ host: "snap.lan" })), "snap.lan:1705,snap.lan:1780")
  assertEquals(M.netAllowList(M.normalizeSettings({ host: "snap.lan", coverArt: "off" })), "snap.lan:1705")
  assertEquals(M.netAllowList(M.normalizeSettings({ host: "snap.lan", coverArt: "any" })), "*")
  assertEquals(M.netAllowList(M.normalizeSettings({ host: "::1" })), "[::1]:1705,[::1]:1780")
  assertEquals(M.netAllowList(M.normalizeSettings({})), "")
})

// ---------------------------------------------------------------- snapclient

Deno.test("snapclientArgs: URL form for >= 0.28, -h/-p before", () => {
  const opts = { host: "snap.lan", port: 1704, hostId: "omarchy-box", player: "pulse", soundcard: "", latency: 0 }
  assertEquals(M.snapclientArgs(opts, "0.35.0"), [
    "--hostID",
    "omarchy-box",
    "--player",
    "pulse",
    "--logsink",
    "stderr",
    "tcp://snap.lan:1704",
  ])
  assertEquals(M.snapclientArgs({ ...opts, latency: 30, soundcard: "default" }, [0, 27, 0]), [
    "--hostID",
    "omarchy-box",
    "--player",
    "pulse",
    "--logsink",
    "stderr",
    "--soundcard",
    "default",
    "--latency",
    "30",
    "-h",
    "snap.lan",
    "-p",
    "1704",
  ])
  assertEquals(M.snapclientArgs({ ...opts, host: "::1" }, null).at(-1), "tcp://[::1]:1704")
})

Deno.test("snapclientArgs refuses invalid options", () => {
  const ok = { host: "snap.lan", port: 1704, hostId: "omarchy-box", player: "pulse", soundcard: "", latency: 0 }
  assertThrows(() => M.snapclientArgs({ ...ok, host: "a;b" }, null), /host/)
  assertThrows(() => M.snapclientArgs({ ...ok, port: 0 }, null), /port/)
  assertThrows(() => M.snapclientArgs({ ...ok, hostId: "--daemon" + " x" }, null), /host id/)
  assertThrows(() => M.snapclientArgs({ ...ok, player: "file:/etc/passwd" }, null), /player/)
  assertThrows(() => M.snapclientArgs({ ...ok, soundcard: "$(rm)" }, null), /soundcard/)
})

Deno.test("parseVersion / versionAtLeast / defaultHostId", () => {
  assertEquals(M.parseVersion("snapclient v0.35.0\nCopyright"), [0, 35, 0])
  assertEquals(M.parseVersion("nope"), null)
  assert(M.versionAtLeast("0.28.0", 0, 28))
  assert(!M.versionAtLeast("0.27.9", 0, 28))
  assert(M.versionAtLeast(null, 0, 28))
  assertEquals(M.defaultHostId("my box!"), "omarchy-mybox")
  assertEquals(M.defaultHostId(""), "omarchy-desktop")
})

Deno.test("parseSoundcards reads snapclient --list output", () => {
  const out =
    "0: null\nDiscard all samples (playback) or generate zero samples (capture)\n\n1: default\nDefault ALSA Output\n\n2: $(evil)\n"
  assertEquals(M.parseSoundcards(out), [
    { value: "null", label: "null — Discard all samples (playback) or generate zero samples (capture)" },
    { value: "default", label: "default — Default ALSA Output" },
  ])
})

// ------------------------------------------------------------------- display

Deno.test("neutralize breaks tag-shaped text but keeps its look", () => {
  assertEquals(M.neutralize("<img src=x>"), "<​img src=x>")
  assertEquals(M.neutralize("a < b"), "a <​ b")
  assertEquals(M.neutralize(null), "")
  assertEquals(M.neutralize(5), "5")
})

Deno.test("findEntrySettings finds the widget entry in any section", () => {
  const cfg = { layout: { left: [{ id: "x" }], right: [{ id: "odach.snapcast-ctrl", host: "a" }] } }
  assertEquals(M.findEntrySettings(cfg, "odach.snapcast-ctrl").host, "a")
  assertEquals(M.findEntrySettings(null, "x"), {})
})

Deno.test("icons are single glyphs", () => {
  for (const [k, v] of Object.entries(M.ICON)) assertEquals([...(v as string)].length, 1, k)
})

Deno.test("localClientName: <hostname> client, sanitized", () => {
  assertEquals(M.localClientName("omarchy"), "omarchy client")
  assertEquals(M.localClientName("bad<b>host"), "badbhost client")
  assertEquals(M.localClientName(""), "Omarchy client")
})
