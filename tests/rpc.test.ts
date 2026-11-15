// JSON-RPC client tests: framing, requests, batches, notifications,
// timeouts, reconnects and hostile server input. Runs against the mock server.

import { LineSplitter, SnapcastRpc } from "../helper/rpc_client.ts"
import { MemoryLogger } from "../helper/log.ts"
import { MockSnapserver } from "./tools/mock_snapserver.ts"
import { assert, assertEquals, assertRejects, waitFor } from "./_assert.ts"

const enc = new TextEncoder()

Deno.test("LineSplitter joins split chunks and handles CRLF", () => {
  const s = new LineSplitter(100)
  assertEquals(s.push(enc.encode('{"a":')), [])
  assertEquals(s.push(enc.encode('1}\r\n{"b":2}\n{"c"')), ['{"a":1}', '{"b":2}'])
  assertEquals(s.push(enc.encode(":3}\n")), ['{"c":3}'])
})

Deno.test("LineSplitter drops oversized lines and recovers", () => {
  const s = new LineSplitter(10)
  assertEquals(s.push(enc.encode("x".repeat(25))), [])
  assertEquals(s.push(enc.encode("yyy\nok\n")), ["ok"])
  assertEquals(s.overflows, 1)
  assertEquals(s.push(enc.encode("x".repeat(11) + "\nfine\n")), ["fine"])
  assertEquals(s.overflows, 2)
})

Deno.test("LineSplitter keeps multi-byte characters intact across chunks", () => {
  const s = new LineSplitter(100)
  const bytes = enc.encode("Küche\n")
  assertEquals(s.push(bytes.subarray(0, 2)), [])
  assertEquals(s.push(bytes.subarray(2)), ["Küche"])
})

async function connected(mock: MockSnapserver, extra: Partial<ConstructorParameters<typeof SnapcastRpc>[0]> = {}) {
  const notes: [string, unknown][] = []
  const states: string[] = []
  const rpc = new SnapcastRpc({
    host: "127.0.0.1",
    port: mock.rpcPort,
    log: new MemoryLogger(),
    backoff: [20],
    onNotification: (m, p) => notes.push([m, p]),
    onState: (s) => states.push(s),
    ...extra,
  })
  rpc.start()
  await waitFor(() => rpc.connected, 3000, "connect")
  return { rpc, notes, states }
}

Deno.test("request/response and server errors", async () => {
  const mock = await MockSnapserver.start()
  const { rpc } = await connected(mock)
  try {
    assertEquals(await rpc.request("Server.GetRPCVersion"), { major: 2, minor: 0, patch: 0 })
    const err = await assertRejects(() => rpc.request("No.Such"), /Method not found/)
    assertEquals((err as { code?: number }).code, -32601)
  } finally {
    rpc.stop()
    await mock.close()
  }
})

Deno.test("batch returns one settled result per call, in order", async () => {
  const mock = await MockSnapserver.start()
  const { rpc } = await connected(mock)
  try {
    const r = await rpc.batch([
      { method: "Client.SetVolume", params: { id: "b8:27:eb:45:e1:ae", volume: { percent: 10, muted: false } } },
      { method: "Client.SetVolume", params: { id: "nope", volume: { percent: 10, muted: false } } },
      { method: "Server.GetRPCVersion" },
    ])
    assertEquals(r.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"])
    assertEquals((r[0] as PromiseFulfilledResult<unknown>).value, { volume: { percent: 10, muted: false } })
  } finally {
    rpc.stop()
    await mock.close()
  }
})

Deno.test("notifications from another controller arrive; own changes are not echoed", async () => {
  const mock = await MockSnapserver.start()
  const a = await connected(mock)
  const b = await connected(mock)
  try {
    await a.rpc.request("Group.SetMute", { id: "1d5d515b-d5c0-2831-6415-c85225c4315f", mute: true })
    await waitFor(() => b.notes.length > 0, 2000, "notification")
    assertEquals(b.notes[0][0], "Group.OnMute")
    assertEquals(a.notes.length, 0)
  } finally {
    a.rpc.stop()
    b.rpc.stop()
    await mock.close()
  }
})

Deno.test("notification batches are delivered one by one", async () => {
  const mock = await MockSnapserver.start()
  const { rpc, notes } = await connected(mock)
  try {
    mock.broadcast([
      { jsonrpc: "2.0", method: "Group.OnMute", params: { id: "g", mute: true } },
      { jsonrpc: "2.0", method: "Group.OnNameChanged", params: { id: "g", name: "x" } },
    ])
    await waitFor(() => notes.length === 2, 2000, "two notifications")
    assertEquals(notes.map((n) => n[0]), ["Group.OnMute", "Group.OnNameChanged"])
  } finally {
    rpc.stop()
    await mock.close()
  }
})

Deno.test("requests time out", async () => {
  const mock = await MockSnapserver.start()
  mock.delays["Server.GetStatus"] = 400
  const { rpc } = await connected(mock, { requestTimeoutMs: 100 })
  try {
    await assertRejects(() => rpc.request("Server.GetStatus"), /timed out/)
  } finally {
    rpc.stop()
    await mock.close()
  }
})

Deno.test("reconnects after the server drops the connection and fails pending requests", async () => {
  const mock = await MockSnapserver.start()
  mock.delays["Server.GetStatus"] = 300
  const { rpc, states } = await connected(mock)
  try {
    const pending = rpc.request("Server.GetStatus")
    await new Promise((r) => setTimeout(r, 30))
    mock.dropAll()
    await assertRejects(() => pending)
    await waitFor(() => states.includes("disconnected"), 2000, "disconnected")
    await waitFor(() => rpc.connected, 3000, "reconnect")
    delete mock.delays["Server.GetStatus"]
    const st = await rpc.request("Server.GetStatus") as { server: { groups: unknown[] } }
    assertEquals(st.server.groups.length, 2)
  } finally {
    rpc.stop()
    await mock.close()
  }
})

Deno.test("connecting to a closed port keeps retrying without throwing", async () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 })
  const port = (l.addr as Deno.NetAddr).port
  l.close()
  const states: string[] = []
  const rpc = new SnapcastRpc({ host: "127.0.0.1", port, log: new MemoryLogger(), backoff: [10], onState: (s) => states.push(s) })
  rpc.start()
  try {
    await waitFor(() => states.filter((s) => s === "disconnected").length >= 2, 3000, "retries")
    assert(rpc.lastError !== "")
    await assertRejects(() => rpc.request("Server.GetStatus"), /not connected/)
  } finally {
    rpc.stop()
  }
})

Deno.test("hostile input: invalid JSON, oversized lines, junk ids", async () => {
  const mock = await MockSnapserver.start()
  const log = new MemoryLogger()
  const { rpc, notes } = await connected(mock, { log })
  try {
    mock.sendRaw("this is not json\n")
    mock.sendRaw('{"jsonrpc":"2.0","id":99999,"result":1}\n') // unknown id
    mock.sendRaw('[1,2,null,"x"]\n')
    mock.sendRaw('{"jsonrpc":"2.0","method":"Group.OnMute","params":' + '"' + "x".repeat(5 * 1024 * 1024) + '"}\n')
    mock.sendRaw('{"jsonrpc":"2.0","method":"After","params":{}}\n')
    await waitFor(() => notes.some((n) => n[0] === "After"), 5000, "recovery")
    assertEquals(notes.map((n) => n[0]), ["After"])
    assert(log.lines.some((l) => l.includes("invalid JSON")))
    assert(log.lines.some((l) => l.includes("oversized")))
    assertEquals(await rpc.request("Server.GetRPCVersion"), { major: 2, minor: 0, patch: 0 })
  } finally {
    rpc.stop()
    await mock.close()
  }
})

Deno.test("onConnected runs before the state turns connected; a failure there reconnects", async () => {
  const mock = await MockSnapserver.start({ auth: { user: "u", password: "p" } })
  let calls = 0
  const rpc = new SnapcastRpc({
    host: "127.0.0.1",
    port: mock.rpcPort,
    log: new MemoryLogger(),
    backoff: [20],
    async onConnected(r) {
      calls++
      if (calls === 1) await r.request("Server.GetStatus") // 401 → reconnect
      else await r.request("Server.Authenticate", { scheme: "Basic", param: btoa("u:p") })
    },
  })
  rpc.start()
  try {
    await waitFor(() => rpc.connected, 3000, "connect after auth")
    assert(calls >= 2)
    const st = await rpc.request("Server.GetStatus") as { server: unknown }
    assert(st.server)
  } finally {
    rpc.stop()
    await mock.close()
  }
})
