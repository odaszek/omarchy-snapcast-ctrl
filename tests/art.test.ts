// Cover art: URL policy, size and type checks, and the on-disk cache.

import { ArtCache, MAX_ART_BYTES, resolveArtUrl, sniffImage } from "../helper/art.ts"
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
    again.fetcher = () => Promise.reject(new Error("should not fetch"))
    assertEquals(await again.get(base + "/__image_cache?name=a.png"), path)

    assertEquals(await cache.get(base + "/not-image.png"), "")
    assertEquals(await cache.get(base + "/big.png"), "")
    assertEquals(await cache.get(base + "/missing.png"), "")
    assertEquals(cache.peek(base + "/missing.png"), "")
    assert(MAX_ART_BYTES < 5 * 1024 * 1024)
  } finally {
    await mock.close()
    await Deno.remove(dir, { recursive: true })
  }
})
