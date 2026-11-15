// Cover art. The panel never loads remote images itself: the helper fetches
// an art URL (subject to the user's policy), checks that it is a small image,
// and stores it under <state>/art/, and the panel shows the local file.
//
// Policies:
//   "server"  only the Snapcast server's own HTTP port (snapserver's image
//             cache, /__image_cache?name=…). Deno's --allow-net enforces it too.
//   "any"     any public http(s) host, e.g. Spotify's CDN. Off by default: it
//             tells third parties what is playing. Loopback and private
//             addresses other than the server stay blocked, so a hostile
//             server can't point the helper at routers or local services.
//   "off"     no cover art.

import type { Logger } from "./log.ts"

export const MAX_ART_BYTES = 4 * 1024 * 1024
const MAX_CACHE_FILES = 64
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 3
const RETRY_FAILED_MS = 60 * 1000

const MAGIC: [string, number[]][] = [
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["jpg", [0xff, 0xd8, 0xff]],
  ["gif", [0x47, 0x49, 0x46, 0x38]],
  ["webp", [0x52, 0x49, 0x46, 0x46]], // RIFF; checked for WEBP below
]

/** File extension from the image's magic bytes, or "" if it is not an image we accept. */
export function sniffImage(bytes: Uint8Array): string {
  for (const [ext, sig] of MAGIC) {
    if (bytes.length < sig.length) continue
    if (!sig.every((b, i) => bytes[i] === b)) continue
    if (ext === "webp") {
      if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") continue
    }
    return ext
  }
  return ""
}

function bracket(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host
}

/** Loopback, private, link-local and similar hosts (IP literals and localhost names). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (h === "" || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2])
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (h.includes(":")) {
    // IPv6 literal: only global unicast (2000::/3) counts as public, and not
    // the ranges that embed an IPv4 address (6to4, Teredo, NAT64 are rare
    // enough to refuse outright).
    if (!/^[23]/.test(h) || h.startsWith("2002:") || h.startsWith("2001:0:") || h.startsWith("2001::")) return true
    return false
  }
  // A single label ("router", "nas") is a LAN name.
  return !h.includes(".")
}

/**
 * The URL to fetch for `artUrl` under `policy`, or "" when it is not allowed.
 * snapserver writes its own host name into image-cache URLs, which may not
 * resolve here, so those are pointed at the configured server address.
 */
export function resolveArtUrl(artUrl: string, policy: string, serverHost: string, httpPort: number): string {
  if (policy === "off" || !artUrl) return ""
  let u: URL
  try {
    u = new URL(artUrl)
  } catch {
    return ""
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return ""
  if (u.username || u.password) return ""
  if (u.pathname === "/__image_cache") {
    const name = u.searchParams.get("name") ?? ""
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return ""
    return "http://" + bracket(serverHost) + ":" + httpPort + "/__image_cache?name=" + encodeURIComponent(name)
  }
  const host = u.hostname.replace(/^\[|\]$/g, "")
  const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80)
  // The server's own HTTP port is fine under either policy.
  if (host.toLowerCase() === serverHost.toLowerCase().replace(/^\[|\]$/g, "") && port === httpPort) return u.href
  if (policy === "any" && !isPrivateHost(host)) return u.href
  return ""
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export class ArtCache {
  #dir: string
  #log: Logger
  #inflight = new Map<string, Promise<string>>()
  #known = new Map<string, { path: string; at: number }>() // path "" = failed
  fetcher: typeof fetch = fetch
  /** Decides whether a redirect target may be followed (same policy as the first URL). */
  allow: (url: string) => boolean = () => true

  constructor(stateDir: string, log: Logger) {
    this.#dir = stateDir + "/art"
    this.#log = log
    try {
      Deno.mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    } catch { /* reported on first write */ }
  }

  /** Cached result without fetching: a path, "" (failed) or undefined (unknown). */
  peek(url: string): string | undefined {
    const k = this.#known.get(url)
    if (!k) return undefined
    // A failure is retried after a while: it may have been a timeout.
    if (k.path === "" && Date.now() - k.at > RETRY_FAILED_MS) return undefined
    return k.path
  }

  /** Local file path of the image at `url` (already resolved by resolveArtUrl), or "" on failure. */
  get(url: string): Promise<string> {
    const known = this.peek(url)
    if (known !== undefined) return Promise.resolve(known)
    let p = this.#inflight.get(url)
    if (!p) {
      p = this.#fetch(url).then((path) => {
        this.#known.delete(url)
        this.#known.set(url, { path, at: Date.now() })
        if (this.#known.size > 512) this.#known.delete(this.#known.keys().next().value as string)
        return path
      }).finally(() => this.#inflight.delete(url))
      this.#inflight.set(url, p)
    }
    return p
  }

  async #fetch(url: string): Promise<string> {
    const key = await sha256Hex(url)
    for (const [ext] of MAGIC) {
      const path = this.#dir + "/" + key + "." + ext
      try {
        await Deno.stat(path)
        return path
      } catch { /* not cached */ }
    }
    try {
      // Redirects are followed by hand so every hop passes the policy check.
      const signal = AbortSignal.timeout(TIMEOUT_MS)
      let target = url
      let res = await this.fetcher(target, { signal, redirect: "manual" })
      for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
        const location = res.headers.get("location")
        await res.body?.cancel()
        if (!location || hop >= MAX_REDIRECTS) return ""
        let next: URL
        try {
          next = new URL(location, target)
        } catch {
          return ""
        }
        if ((next.protocol !== "http:" && next.protocol !== "https:") || next.username || next.password || !this.allow(next.href)) {
          this.#log.debug("art: redirect refused: " + url)
          return ""
        }
        target = next.href
        res = await this.fetcher(target, { signal, redirect: "manual" })
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel()
        this.#log.debug("art: HTTP " + res.status + " for " + url)
        return ""
      }
      const declared = Number(res.headers.get("content-length") ?? "0")
      if (declared > MAX_ART_BYTES) {
        await res.body.cancel()
        return ""
      }
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_ART_BYTES) {
          await reader.cancel()
          this.#log.debug("art: image too large: " + url)
          return ""
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let off = 0
      for (const c of chunks) {
        bytes.set(c, off)
        off += c.length
      }
      const ext = sniffImage(bytes)
      if (!ext) {
        this.#log.debug("art: not an image: " + url)
        return ""
      }
      const path = this.#dir + "/" + key + "." + ext
      const tmp = path + ".tmp"
      await Deno.writeFile(tmp, bytes, { mode: 0o600 })
      await Deno.rename(tmp, path)
      await this.#prune()
      return path
    } catch (e) {
      this.#log.debug("art: " + (e instanceof Error ? e.message : String(e)))
      return ""
    }
  }

  async #prune(): Promise<void> {
    const files: { path: string; mtime: number }[] = []
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (!entry.isFile) continue
        const path = this.#dir + "/" + entry.name
        const st = await Deno.stat(path)
        files.push({ path, mtime: st.mtime?.getTime() ?? 0 })
      }
    } catch {
      return
    }
    if (files.length <= MAX_CACHE_FILES) return
    files.sort((a, b) => a.mtime - b.mtime)
    for (const f of files.slice(0, files.length - MAX_CACHE_FILES)) {
      try {
        await Deno.remove(f.path)
      } catch { /* gone */ }
      for (const [u, k] of this.#known) if (k.path === f.path) this.#known.delete(u)
    }
  }
}
