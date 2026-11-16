// Cover art: URL policy, size and type checks, and the on-disk cache.

import { ArtCache, isPrivateHost, isServerUrl, MAX_ART_BYTES, pinnedGet, resolveArtUrl, sniffImage } from "../helper/art.ts"
import { MemoryLogger } from "../helper/log.ts"
import { MockSnapserver, PNG_1PX } from "./tools/mock_snapserver.ts"
import { assert, assertEquals } from "./_assert.ts"

Deno.test("resolveArtUrl: server policy allows only the server's HTTP port", () => {
  const r = (u: string, policy = "server") => resolveArtUrl(u, policy, "snap.lan", 1780)
  assertEquals(r("http://snap.lan:1780/__image_cache?name=a.png"), "http://snap.lan:1780/__image_cache?name=a.png")
  // snapserver writes its own host name; point it at the configured address.
  assertEquals(r("http://raspberrypi:1780/__image_cache?name=a.png"), "http://snap.lan:1780/__image_cache?name=a.png")
  assertEquals(r("http://snap.lan:1780/other.png"), "http://snap.lan:1780/other.png")
  assertEquals(r("http://i.scdn.co/image/x"), "")
  assertEquals(r("http://snap.lan:22/x"), "")
  assertEquals(r("http://snap.lan/x"), "")
})

Deno.test("resolveArtUrl: any policy, off, and hostile URLs", () => {
  const r = (u: string, policy = "any") => resolveArtUrl(u, policy, "snap.lan", 1780)
  assertEquals(r("https://i.scdn.co/image/x"), "https://i.scdn.co/image/x")
  assertEquals(r("https://i.scdn.co/image/x", "off"), "")
  assertEquals(r("file:///etc/passwd"), "")
  assertEquals(r("javascript:alert(1)"), "")
  assertEquals(r("http://user:pw@host/x"), "")
  assertEquals(r("not a url"), "")
  assertEquals(r("http://snap.lan:1780/__image_cache?name=../../etc"), "")
  assertEquals(r(""), "")
})

Deno.test("any policy never reaches loopback, private or LAN hosts (other than the server)", () => {
  const r = (u: string) => resolveArtUrl(u, "any", "192.168.1.10", 1780)
  for (
    const u of [
      "http://127.0.0.1:8080/x.png",
      "http://localhost/x.png",
      "http://2130706433/x.png", // 127.0.0.1 as an integer
      "http://0x7f.1/x.png",
      "http://192.168.1.1/admin.png",
      "http://10.0.0.5/x",
      "http://172.20.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/x",
      "http://[::1]/x",
      "http://[fe80::1]/x",
      "http://[fd00::1]/x",
      "http://[::ffff:127.0.0.1]/x",
      "http://router/x.png",
      "http://nas.local/x.png",
      "http://192.168.1.10:22/x", // the server, but not its HTTP port
    ]
  ) assertEquals(r(u), "", u)
  assertEquals(r("http://192.168.1.10:1780/cover.png"), "http://192.168.1.10:1780/cover.png")
  assertEquals(r("https://i.scdn.co/image/x"), "https://i.scdn.co/image/x")
  assertEquals(r("http://[2606:4700::1]/x"), "http://[2606:4700::1]/x")
  assert(isPrivateHost("LOCALHOST.") && !isPrivateHost("example.com"))
})

Deno.test("resolveArtUrl brackets IPv6 server addresses", () => {
  assertEquals(
    resolveArtUrl("http://x:1780/__image_cache?name=a.png", "server", "fe80::1", 1780),
    "http://[fe80::1]:1780/__image_cache?name=a.png",
  )
})

Deno.test("sniffImage recognises image formats only", () => {
  assertEquals(sniffImage(PNG_1PX), "png")
  assertEquals(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpg")
  assertEquals(sniffImage(new TextEncoder().encode("RIFF....WEBPVP8 ")), "webp")
  assertEquals(sniffImage(new TextEncoder().encode("RIFF....WAVEfmt ")), "")
  assertEquals(sniffImage(new TextEncoder().encode("<svg onload=x>")), "")
  assertEquals(sniffImage(new Uint8Array(0)), "")
})

Deno.test("ArtCache downloads, caches and rejects non-images and oversized files", async () => {
  const mock = await MockSnapserver.start()
  const dir = await Deno.makeTempDir()
  try {
    const cache = new ArtCache(dir, new MemoryLogger())
    cache.direct = () => true // the mock plays the configured server
    let fetches = 0
    const real = cache.fetcher
    cache.fetcher = (input, init) => {
      fetches++
      return real(input, init)
    }
    const base = "http://127.0.0.1:" + mock.httpPort
    const path = await cache.get(base + "/__image_cache?name=a.png")
    assert(path.startsWith(dir + "/art/") && path.endsWith(".png"), path)
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600)
    assertEquals(await cache.get(base + "/__image_cache?name=a.png"), path)
    assertEquals(fetches, 1, "second get is served from memory")
    // A new cache instance finds the file on disk.
    const again = new ArtCache(dir, new MemoryLogger())
    again.direct = () => true
    again.fetcher = () => Promise.reject(new Error("should not fetch"))
    assertEquals(await again.get(base + "/__image_cache?name=a.png"), path)

    assertEquals(await cache.get(base + "/not-image.png"), "")
    assertEquals(await cache.get(base + "/big.png"), "")
    assertEquals(await cache.get(base + "/missing.png"), "")
    assertEquals(cache.peek(base + "/missing.png"), "")
    assert(MAX_ART_BYTES < 5 * 1024 * 1024)

    // Redirects are followed only while the policy check allows the target.
    const hops: string[] = []
    const redirecting = new ArtCache(dir, new MemoryLogger())
    redirecting.direct = () => true
    redirecting.fetcher = (input, init) => {
      const u = String(input)
      hops.push(u)
      assertEquals((init as RequestInit).redirect, "manual")
      if (u.endsWith("/start")) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/secret" } }))
      }
      return Promise.resolve(new Response(PNG_1PX, { status: 200 }))
    }
    redirecting.allow = (u) => !u.includes("127.0.0.1:9")
    assertEquals(await redirecting.get("http://cdn.example/start"), "")
    assertEquals(hops, ["http://cdn.example/start"], "the refused target is never requested")
    redirecting.allow = () => true
    hops.length = 0
    const other = new ArtCache(dir, new MemoryLogger())
    other.direct = () => true
    other.fetcher = redirecting.fetcher
    assert((await other.get("http://cdn.example/start")).endsWith(".png"))
    assertEquals(hops.length, 2)
  } finally {
    await mock.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("isServerUrl matches only the configured server's HTTP port", () => {
  assert(isServerUrl("http://snap.lan:1780/__image_cache?name=a.png", "snap.lan", 1780))
  assert(isServerUrl("http://SNAP.lan:1780/x", "snap.lan", 1780))
  assert(isServerUrl("http://[fe80::1]:1780/x", "fe80::1", 1780))
  assert(!isServerUrl("http://snap.lan:22/x", "snap.lan", 1780))
  assert(!isServerUrl("http://snap.lan/x", "snap.lan", 1780))
  assert(!isServerUrl("http://evil.example:1780/x", "snap.lan", 1780))
  assert(!isServerUrl("file:///etc/passwd", "snap.lan", 1780))
  assert(!isServerUrl("http://x:1780/", "", 1780))
})

Deno.test("other hosts are resolved, must be public, and are fetched from the checked address", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const dns: Record<string, string[]> = {
      "rebind.example": ["10.0.0.5"],
      "mixed.example": ["93.184.216.34", "127.0.0.1"],
      "v6local.example": ["::1"],
      "empty.example": [],
      "cdn.example": ["93.184.216.34"],
      "hop.example": ["93.184.216.35"],
    }
    const pinned: [string, string][] = []
    const cache = new ArtCache(dir, new MemoryLogger())
    cache.fetcher = () => Promise.reject(new Error("plain fetch must not be used"))
    cache.resolver = (h) => Promise.resolve(dns[h] ?? [])
    cache.pinnedFetcher = (u, ip) => {
      pinned.push([u.href, ip])
      if (u.pathname === "/redirect") {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://rebind.example/x.png" } }))
      }
      return Promise.resolve(new Response(PNG_1PX, { status: 200 }))
    }
    for (const h of ["rebind.example", "mixed.example", "v6local.example", "empty.example"]) {
      assertEquals(await cache.get("http://" + h + "/x.png"), "", h)
    }
    assertEquals(pinned, [], "nothing is requested from a name with a private (or no) address")

    // A redirect to a name that resolves privately is refused on that hop.
    assertEquals(await cache.get("http://hop.example/redirect"), "")
    assertEquals(pinned, [["http://hop.example/redirect", "93.184.216.35"]])

    pinned.length = 0
    const path = await cache.get("https://cdn.example/cover.png")
    assert(path.endsWith(".png"), path)
    assertEquals(pinned, [["https://cdn.example/cover.png", "93.184.216.34"]], "fetched from the checked address")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("pinnedGet: talks HTTP/1.1 to the given address with the URL's Host, handles chunked bodies, caps size", async () => {
  const hosts: string[] = []
  const big = new Uint8Array(2048)
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    hosts.push(req.headers.get("host") ?? "")
    const path = new URL(req.url).pathname
    if (path === "/chunked") {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(PNG_1PX.subarray(0, 10))
            c.enqueue(PNG_1PX.subarray(10))
            c.close()
          },
        }),
        { headers: { "content-type": "image/png" } },
      )
    }
    if (path === "/big") return new Response(big)
    if (path === "/moved") return new Response(null, { status: 302, headers: { location: "/x" } })
    return new Response(PNG_1PX, { headers: { "content-type": "image/png" } })
  })
  const port = server.addr.port
  try {
    const signal = AbortSignal.timeout(3000)
    const r = await pinnedGet(new URL("http://cover.example:" + port + "/x.png?a=1"), "127.0.0.1", signal)
    assertEquals(r.status, 200)
    assertEquals(new Uint8Array(await r.arrayBuffer()), PNG_1PX)
    assertEquals(hosts[0], "cover.example:" + port)
    const c = await pinnedGet(new URL("http://cover.example:" + port + "/chunked"), "127.0.0.1", signal)
    assertEquals(new Uint8Array(await c.arrayBuffer()), PNG_1PX)
    const m = await pinnedGet(new URL("http://cover.example:" + port + "/moved"), "127.0.0.1", signal)
    assertEquals([m.status, m.headers.get("location")], [302, "/x"])
    let threw = false
    try {
      await pinnedGet(new URL("http://cover.example:" + port + "/big"), "127.0.0.1", signal, 1024)
    } catch {
      threw = true
    }
    assert(threw, "bodies over the cap are refused")
  } finally {
    await server.shutdown()
  }
})
