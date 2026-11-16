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
//             server can't point the helper at routers or local services:
//             names are resolved here, every address must be public, and
//             the request goes to that checked address (no second lookup
//             that DNS rebinding could answer differently).
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

const MAX_HEADER_BYTES = 32 * 1024

/** A, AAAA and IP-literal resolution for a host name. */
export async function resolveHost(host: string): Promise<string[]> {
  const h = host.replace(/^\[|\]$/g, "")
  if (/^[\d.]+$/.test(h) || h.includes(":")) return [h]
  const [v4, v6] = await Promise.all([
    Deno.resolveDns(h, "A").catch(() => [] as string[]),
    Deno.resolveDns(h, "AAAA").catch(() => [] as string[]),
  ])
  return [...v4, ...v6]
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function dechunk(body: Uint8Array): Uint8Array {
  const out: Uint8Array[] = []
  let size = 0
  let i = 0
  const dec = new TextDecoder()
  for (;;) {
    let eol = i
    while (eol + 1 < body.length && !(body[eol] === 13 && body[eol + 1] === 10)) eol++
    if (eol + 1 >= body.length) throw new Error("truncated chunked body")
    const len = parseInt(dec.decode(body.subarray(i, eol)).split(";")[0].trim(), 16)
    if (!Number.isFinite(len) || len < 0) throw new Error("bad chunk size")
    i = eol + 2
    if (len === 0) return concat(out, size)
    if (i + len > body.length) throw new Error("truncated chunk")
    out.push(body.subarray(i, i + len))
    size += len
    i += len + 2
  }
}

/**
 * GET `url` from the already-checked address `ip` (HTTP/1.1, one request,
 * no redirects). TLS still verifies the certificate for the URL's host name.
 * The body is capped at `maxBytes`.
 */
export async function pinnedGet(url: URL, ip: string, signal: AbortSignal, maxBytes = MAX_ART_BYTES): Promise<Response> {
  const https = url.protocol === "https:"
  const port = url.port ? Number(url.port) : (https ? 443 : 80)
  let conn: Deno.Conn = await Deno.connect({ hostname: ip, port })
  const abort = () => {
    try {
      conn.close()
    } catch { /* closed */ }
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    if (https) conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: url.hostname.replace(/^\[|\]$/g, "") })
    const req = "GET " + (url.pathname || "/") + url.search + " HTTP/1.1\r\nHost: " + url.host +
      "\r\nUser-Agent: omarchy-snapcast-ctrl\r\nAccept: image/*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
    const bytes = new TextEncoder().encode(req)
    for (let off = 0; off < bytes.length;) off += await conn.write(bytes.subarray(off))
    const chunks: Uint8Array[] = []
    let size = 0
    const buf = new Uint8Array(64 * 1024)
    for (;;) {
      let n: number | null
      try {
        n = await conn.read(buf)
      } catch (e) {
        // Many servers close TLS without close_notify; the body framing
        // (Content-Length or chunked) below still catches truncation.
        if (e instanceof Deno.errors.UnexpectedEof) break
        throw e
      }
      if (n === null) break
      size += n
      if (size > maxBytes + MAX_HEADER_BYTES) throw new Error("response too large")
      chunks.push(buf.slice(0, n))
    }
    const raw = concat(chunks, size)
    let end = -1
    for (let i = 0; i + 3 < raw.length && i < MAX_HEADER_BYTES; i++) {
      if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
        end = i
        break
      }
    }
    if (end < 0) throw new Error("no HTTP header")
    const lines = new TextDecoder().decode(raw.subarray(0, end)).split("\r\n")
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0])
    if (!m) throw new Error("bad HTTP status line")
    const status = Number(m[1])
    const headers = new Headers()
    for (const line of lines.slice(1)) {
      const c = line.indexOf(":")
      if (c > 0) headers.append(line.slice(0, c).trim(), line.slice(c + 1).trim())
    }
    let body = raw.subarray(end + 4)
    if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) body = dechunk(body)
    else if (headers.has("content-length")) {
      const len = Number(headers.get("content-length"))
      if (!Number.isInteger(len) || len < 0 || len > body.length) throw new Error("truncated body")
      body = body.subarray(0, len)
    }
    if (body.length > maxBytes) throw new Error("response too large")
    headers.delete("transfer-encoding")
    headers.set("content-length", String(body.length))
    const nullBody = status === 204 || status === 205 || status === 304
    return new Response(nullBody ? null : body.slice(), { status, headers })
  } finally {
    signal.removeEventListener("abort", abort)
    abort()
  }
}

/** True for http(s) URLs on the configured server's own HTTP port. */
export function isServerUrl(url: string, serverHost: string, httpPort: number): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80)
  const strip = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "")
  return serverHost !== "" && strip(u.hostname) === strip(serverHost) && port === httpPort
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
  /** Plain fetch, used only for `direct` URLs (the configured server). */
  fetcher: typeof fetch = fetch
  /** Decides whether a redirect target may be followed (same policy as the first URL). */
  allow: (url: string) => boolean = () => true
  /** URLs fetched without the address check: the configured server's own HTTP port. */
  direct: (url: string) => boolean = () => false
  /** Every other host is resolved here and fetched from a checked public address. */
  resolver: (host: string) => Promise<string[]> = resolveHost
  pinnedFetcher: (url: URL, ip: string, signal: AbortSignal) => Promise<Response> = pinnedGet

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
      let res = await this.#request(target, signal)
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
        res = await this.#request(target, signal)
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

  /**
   * One request without following redirects. Anything but the configured
   * server must resolve only to public addresses, and is fetched from the
   * address that was checked.
   */
  async #request(target: string, signal: AbortSignal): Promise<Response> {
    if (this.direct(target)) return this.fetcher(target, { signal, redirect: "manual" })
    const u = new URL(target)
    const host = u.hostname.replace(/^\[|\]$/g, "")
    const addrs = await this.resolver(host)
    if (addrs.length === 0) throw new Error("no address for " + host)
    if (addrs.some((a) => isPrivateHost(a))) throw new Error("refused: " + host + " resolves to a private address")
    // IPv4 first (resolveHost order); try the next address if one is unreachable.
    let last: unknown = null
    for (const a of addrs.slice(0, 4)) {
      try {
        return await this.pinnedFetcher(u, a, signal)
      } catch (e) {
        if (signal.aborted) throw e
        last = e
      }
    }
    throw last
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
