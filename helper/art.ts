// Cover art. The panel never loads remote images itself: the helper fetches
// an art URL (subject to the user's policy), checks that it is a small image,
// and stores it under <state>/art/, and the panel shows the local file.
//
// Policies:
//   "server"  only the Snapcast server's own HTTP port (snapserver's image
//             cache, /__image_cache?name=…). Deno's --allow-net enforces it too.
//   "any"     any http(s) host, e.g. Spotify's CDN. Off by default: it tells
//             third parties what is playing.
//   "off"     no cover art.

import type { Logger } from "./log.ts"

export const MAX_ART_BYTES = 4 * 1024 * 1024
const MAX_CACHE_FILES = 64
const TIMEOUT_MS = 8000

const MAGIC: [string, number[]][] = [
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["jpg", [0xff, 0xd8, 0xff]],
  ["gif", [0x47, 0x49, 0x46, 0x38]],
  ["webp", [0x52, 0x49, 0x46, 0x46]], // RIFF; checked for WEBP below
  ["bmp", [0x42, 0x4d]],
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
  if (policy === "any") return u.href
  // "server": only the server's HTTP port.
  const host = u.hostname.replace(/^\[|\]$/g, "")
  const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80)
  if (host.toLowerCase() === serverHost.toLowerCase().replace(/^\[|\]$/g, "") && port === httpPort) return u.href
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
  #known = new Map<string, string>() // url -> path ("" = failed)
  fetcher: typeof fetch = fetch

  constructor(stateDir: string, log: Logger) {
    this.#dir = stateDir + "/art"
    this.#log = log
    try {
      Deno.mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    } catch { /* reported on first write */ }
  }

  /** Cached result without fetching: a path, "" (failed) or undefined (unknown). */
  peek(url: string): string | undefined {
    return this.#known.get(url)
  }

  /** Local file path of the image at `url` (already resolved by resolveArtUrl), or "" on failure. */
  get(url: string): Promise<string> {
    const known = this.#known.get(url)
    if (known !== undefined) return Promise.resolve(known)
    let p = this.#inflight.get(url)
    if (!p) {
      p = this.#fetch(url).then((path) => {
        this.#known.set(url, path)
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
      const res = await this.fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" })
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
      for (const [u, p] of this.#known) if (p === f.path) this.#known.delete(u)
    }
  }
}
