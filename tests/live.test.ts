// Opt-in tests against a real snapserver. Skipped unless SNAPCAST_LIVE is set.
//
//   SNAPCAST_LIVE=192.168.0.5[:1705]          read-only checks
//   SNAPCAST_LIVE_WRITE=1                     also add/remove a test stream and toggle a group's mute (restored)
//   SNAPCAST_LIVE_CAPTURE=/path/status.json   save the normalized status (e.g. for a new fixture)

import { SnapcastRpc } from "../helper/rpc_client.ts"
import { MemoryLogger } from "../helper/log.ts"
import * as M from "../lib/model.mjs"
import { assert, assertEquals, waitFor } from "./_assert.ts"

const target = Deno.env.get("SNAPCAST_LIVE") ?? ""
const write = Deno.env.get("SNAPCAST_LIVE_WRITE") === "1"
const capture = Deno.env.get("SNAPCAST_LIVE_CAPTURE") ?? ""
const [host, portText] = target.includes("]") ? [target.slice(1, target.indexOf("]")), target.split("]:")[1]] : target.split(":")
const port = Number(portText || 1705)

async function withRpc(fn: (rpc: SnapcastRpc) => Promise<void>) {
  const rpc = new SnapcastRpc({ host, port, log: new MemoryLogger() })
  rpc.start()
  try {
    await waitFor(() => rpc.connected, 8000, "connection to " + target)
    await fn(rpc)
  } finally {
    rpc.stop()
  }
}

Deno.test({
  name: "live: version, status and normalization",
  ignore: !target,
  async fn() {
    await withRpc(async (rpc) => {
      const v = await rpc.request("Server.GetRPCVersion") as { major: number }
      assert(v.major >= 2, "RPC major version >= 2")
      const raw = await rpc.request("Server.GetStatus")
      const s = M.normalizeServer(raw)
      assert(s.server.snapserver.version !== "", "server version")
      assert(s.streams.length > 0, "at least one stream")
      // Every group's stream exists; every client id is unique.
      for (const g of s.groups) assert(M.findStream(s, g.stream_id) || g.stream_id === "", "stream of group " + g.id)
      const ids = M.allClients(s).map((c: { id: string }) => c.id)
      assertEquals(new Set(ids).size, ids.length)
      console.log(
        `server ${s.server.snapserver.version}: ${s.groups.length} groups, ${ids.length} clients, ${s.streams.length} streams`,
      )
      if (capture) await Deno.writeTextFile(capture, JSON.stringify({ server: raw }, null, 2))
    })
  },
})

Deno.test({
  name: "live: add and remove a test stream, toggle a group's mute (restored)",
  ignore: !target || !write,
  async fn() {
    await withRpc(async (rpc) => {
      const name = "snapctrl-test-" + Date.now().toString(36)
      const built = M.buildStreamUri({ type: "pipe", name, path: "/tmp/" + name, mode: "create" })
      assert(built.ok)
      const added = await rpc.request("Stream.AddStream", { streamUri: built.uri }) as Record<string, unknown>
      assertEquals(added.id ?? added.stream_id, name)
      try {
        const s = M.normalizeServer(await rpc.request("Server.GetStatus"))
        assert(M.findStream(s, name), "stream listed")
      } finally {
        await rpc.request("Stream.RemoveStream", { id: name })
      }
      const after = M.normalizeServer(await rpc.request("Server.GetStatus"))
      assert(!M.findStream(after, name), "stream removed")

      const g = after.groups[0]
      if (g) {
        await rpc.request("Group.SetMute", { id: g.id, mute: !g.muted })
        await rpc.request("Group.SetMute", { id: g.id, mute: g.muted })
        const back = M.findGroup(M.normalizeServer(await rpc.request("Server.GetStatus")), g.id)
        assertEquals(back.muted, g.muted)
      }
    })
  },
})
