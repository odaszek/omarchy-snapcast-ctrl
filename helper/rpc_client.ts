// Snapcast JSON-RPC 2.0 client over the raw TCP control port (default 1705).
// Messages are newline-delimited JSON in both directions.
//
// The connection reconnects with exponential backoff. Responses are matched
// to requests by id; notifications (no id) go to `onNotification`. A batch
// sent by us is answered with an array; the server may also push batches of
// notifications.

import type { Logger } from "./log.ts"

export const MAX_LINE = 4 * 1024 * 1024

export type ConnState = "idle" | "connecting" | "connected" | "disconnected"

export interface RpcError extends Error {
  code?: number
}

/** Splits a byte stream into lines, dropping any line longer than `max` bytes. */
export class LineSplitter {
  #decoder = new TextDecoder()
  #buffer = ""
  #discarding = false
  overflows = 0

  constructor(private max = MAX_LINE) {}

  push(chunk: Uint8Array): string[] {
    const text = this.#decoder.decode(chunk, { stream: true })
    const out: string[] = []
    let start = 0
    for (;;) {
      const nl = text.indexOf("\n", start)
      if (nl === -1) break
      const piece = text.slice(start, nl)
      if (this.#discarding) {
        this.#discarding = false
      } else {
        const line = this.#buffer + piece
        if (line.length <= this.max) out.push(line.replace(/\r$/, ""))
        else this.overflows++
      }
      this.#buffer = ""
      start = nl + 1
    }
    const rest = text.slice(start)
    if (!this.#discarding) {
      this.#buffer += rest
      if (this.#buffer.length > this.max) {
        this.#buffer = ""
        this.#discarding = true
        this.overflows++
      }
    }
    return out
  }
}

export interface RpcOptions {
  host: string
  port: number
  log: Logger
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  /** Called after every (re)connect, before the state turns "connected". */
  onConnected?: (rpc: SnapcastRpc) => Promise<void>
  onNotification?: (method: string, params: unknown) => void
  onState?: (state: ConnState, error: string) => void
  /** Backoff schedule in ms; the last value repeats. */
  backoff?: number[]
}

type FullOptions = Required<Omit<RpcOptions, "onConnected" | "onNotification" | "onState">> & RpcOptions

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function rpcError(message: string, code?: number): RpcError {
  const e = new Error(message) as RpcError
  e.code = code
  return e
}

export class SnapcastRpc {
  #opts: FullOptions
  #conn: Deno.TcpConn | null = null
  #nextId = 1
  #pending = new Map<number, Pending>()
  #writeChain: Promise<void> = Promise.resolve()
  #running = false
  #attempt = 0
  #wake: (() => void) | null = null
  #state: ConnState = "idle"
  #encoder = new TextEncoder()
  lastError = ""

  constructor(opts: RpcOptions) {
    this.#opts = {
      requestTimeoutMs: 8000,
      connectTimeoutMs: 5000,
      backoff: [500, 1000, 2000, 5000, 10000, 30000],
      ...opts,
    } as FullOptions
  }

  get state(): ConnState {
    return this.#state
  }

  get connected(): boolean {
    return this.#state === "connected"
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#loop()
  }

  stop(): void {
    this.#running = false
    this.#closeConn()
    this.#wake?.()
  }

  /** Drop the current connection (or skip the backoff wait) and connect again now. */
  reconnect(): void {
    this.#attempt = 0
    this.#closeConn()
    this.#wake?.()
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      this.#setState("connecting", this.lastError)
      try {
        const conn = await this.#connect()
        if (!this.#running) {
          try {
            conn.close()
          } catch { /* already closed */ }
          break
        }
        this.#conn = conn
        const reading = this.#readLoop(conn)
        if (this.#opts.onConnected) await this.#opts.onConnected(this)
        this.lastError = ""
        this.#attempt = 0
        this.#setState("connected", "")
        await reading
        if (this.#running) this.lastError = this.lastError || "connection closed by server"
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e)
        this.#opts.log.debug("rpc: " + this.lastError)
      }
      this.#closeConn()
      this.#failPending(this.lastError || "disconnected")
      if (!this.#running) break
      this.#setState("disconnected", this.lastError)
      const schedule = this.#opts.backoff
      const delay = schedule[Math.min(this.#attempt, schedule.length - 1)]
      this.#attempt++
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.#wake = null
          resolve()
        }, delay)
        this.#wake = () => {
          clearTimeout(t)
          this.#wake = null
          resolve()
        }
      })
    }
    this.#setState("idle", "")
  }

  async #connect(): Promise<Deno.TcpConn> {
    const pending = Deno.connect({ hostname: this.#opts.host, port: this.#opts.port, transport: "tcp" })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("connection timed out")), this.#opts.connectTimeoutMs)
    })
    try {
      return await Promise.race([pending, timeout])
    } catch (e) {
      // A connect that completes after the timeout must not leak.
      pending.then((c) => c.close()).catch(() => {})
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async #readLoop(conn: Deno.TcpConn): Promise<void> {
    const splitter = new LineSplitter()
    const buf = new Uint8Array(64 * 1024)
    for (;;) {
      let n: number | null
      try {
        n = await conn.read(buf)
      } catch (e) {
        if (this.#conn === conn) this.lastError = e instanceof Error ? e.message : String(e)
        return
      }
      if (n === null) return
      const before = splitter.overflows
      for (const line of splitter.push(buf.subarray(0, n))) this.#handleLine(line)
      if (splitter.overflows !== before) this.#opts.log.warn("rpc: dropped an oversized message from the server")
    }
  }

  #handleLine(line: string): void {
    if (line.trim() === "") return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.#opts.log.warn("rpc: invalid JSON from the server")
      return
    }
    if (Array.isArray(msg)) {
      // A response batch (to our batch) or a batch of notifications.
      const responses = msg.filter((m) => m && typeof m === "object" && "id" in m && m.id !== null)
      for (const m of msg) {
        if (m && typeof m === "object" && !("id" in m && m.id !== null)) this.#handleObject(m)
      }
      if (responses.length > 0) this.#handleBatchResponse(responses)
      return
    }
    if (msg && typeof msg === "object") this.#handleObject(msg as Record<string, unknown>)
  }

  #handleObject(m: Record<string, unknown>): void {
    if (typeof m.method === "string" && (m.id === undefined || m.id === null)) {
      try {
        this.#opts.onNotification?.(m.method, m.params)
      } catch (e) {
        this.#opts.log.error("rpc: notification handler failed: " + (e instanceof Error ? e.message : e))
      }
      return
    }
    const id = typeof m.id === "number" ? m.id : Number(m.id)
    const p = this.#pending.get(id)
    if (!p) return
    this.#pending.delete(id)
    clearTimeout(p.timer)
    if (m.error && typeof m.error === "object") {
      const err = m.error as Record<string, unknown>
      const data = typeof err.data === "string" ? ": " + err.data : ""
      p.reject(rpcError(String(err.message ?? "request failed").slice(0, 300) + data.slice(0, 300), Number(err.code)))
    } else {
      p.resolve(m.result)
    }
  }

  #handleBatchResponse(items: Record<string, unknown>[]): void {
    // Resolve each item individually; batch() waits on all of its ids.
    for (const item of items) this.#handleObject(item)
  }

  #send(payload: unknown): Promise<void> {
    const conn = this.#conn
    if (!conn || (this.#state !== "connected" && this.#state !== "connecting")) {
      return Promise.reject(rpcError("not connected"))
    }
    const bytes = this.#encoder.encode(JSON.stringify(payload) + "\r\n")
    const write = this.#writeChain.then(async () => {
      let written = 0
      while (written < bytes.length) written += await conn.write(bytes.subarray(written))
    })
    this.#writeChain = write.catch(() => {})
    return write
  }

  #register(id: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(rpcError("request timed out"))
      }, this.#opts.requestTimeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
    })
  }

  /** One request. Resolves with `result`, rejects with the server's error. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.#conn) return Promise.reject(rpcError("not connected"))
    const id = this.#nextId++
    const msg: Record<string, unknown> = { id, jsonrpc: "2.0", method }
    if (params !== undefined) msg.params = params
    const done = this.#register(id)
    this.#send(msg).catch((e) => {
      const p = this.#pending.get(id)
      if (p) {
        this.#pending.delete(id)
        clearTimeout(p.timer)
        p.reject(e instanceof Error ? e : rpcError(String(e)))
      }
    })
    return done
  }

  /** A JSON-RPC batch. Resolves with one settled result per call, in order. */
  batch(calls: { method: string; params?: unknown }[]): Promise<PromiseSettledResult<unknown>[]> {
    if (!this.#conn) return Promise.reject(rpcError("not connected"))
    if (calls.length === 0) return Promise.resolve([])
    const msgs = calls.map((c) => {
      const m: Record<string, unknown> = { id: this.#nextId++, jsonrpc: "2.0", method: c.method }
      if (c.params !== undefined) m.params = c.params
      return m
    })
    const waits = msgs.map((m) => this.#register(m.id as number))
    this.#send(msgs).catch((e) => {
      for (const m of msgs) {
        const p = this.#pending.get(m.id as number)
        if (p) {
          this.#pending.delete(m.id as number)
          clearTimeout(p.timer)
          p.reject(e instanceof Error ? e : rpcError(String(e)))
        }
      }
    })
    return Promise.allSettled(waits)
  }

  #setState(state: ConnState, error: string): void {
    if (state === this.#state && state !== "disconnected") return
    this.#state = state
    try {
      this.#opts.onState?.(state, error)
    } catch { /* ignore */ }
  }

  #closeConn(): void {
    const c = this.#conn
    this.#conn = null
    if (c) {
      try {
        c.close()
      } catch { /* already closed */ }
    }
  }

  #failPending(reason: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(rpcError(reason))
      this.#pending.delete(id)
    }
  }
}
