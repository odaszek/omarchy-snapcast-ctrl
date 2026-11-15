// Local playback: runs the official `snapclient` (AUR package "snapcast") as a
// child of the helper, restarts it with backoff when it dies, and stops it
// when playback is switched off or the helper exits. Arguments are always an
// argv array built by Model.snapclientArgs(); nothing goes through a shell.

import type { Logger } from "./log.ts"
import * as Model from "../lib/model.mjs"

export type LocalState = "unavailable" | "stopped" | "starting" | "running" | "restarting" | "error"

export interface LocalOptions {
  host: string
  port: number
  hostId: string
  player: string
  soundcard: string
  latency: number
}

export interface LocalStatus {
  state: LocalState
  available: boolean
  version: string
  clientId: string
  error: string
  binary: string
}

const BACKOFF = [1000, 2000, 5000, 10000, 30000]
const STABLE_MS = 30000
const MAX_STDERR_LINE = 1000

export class SnapclientSupervisor {
  #binary: string
  #log: Logger
  #onStatus: (s: LocalStatus) => void
  #child: Deno.ChildProcess | null = null
  #opts: LocalOptions | null = null
  #wanted = false
  #attempt = 0
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #version: number[] | null = null
  #versionText = ""
  #available = false
  #state: LocalState = "stopped"
  #error = ""
  #startedAt = 0

  constructor(binary: string, log: Logger, onStatus: (s: LocalStatus) => void) {
    this.#binary = binary
    this.#log = log
    this.#onStatus = onStatus
  }

  status(): LocalStatus {
    return {
      state: this.#state,
      available: this.#available,
      version: this.#versionText,
      clientId: this.#opts ? this.#opts.hostId : "",
      error: this.#error,
      binary: this.#binary,
    }
  }

  #emit(): void {
    try {
      this.#onStatus(this.status())
    } catch { /* ignore */ }
  }

  #set(state: LocalState, error = this.#error): void {
    this.#state = state
    this.#error = error
    this.#emit()
  }

  /** Probe the binary (`snapclient --version`). */
  async detect(): Promise<boolean> {
    try {
      const out = await new Deno.Command(this.#binary, {
        args: ["--version"],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
        env: { PATH: "/usr/local/bin:/usr/bin", LANG: "C.UTF-8" },
      }).output()
      const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)
      this.#version = Model.parseVersion(text)
      this.#versionText = this.#version ? this.#version.join(".") : ""
      this.#available = true
    } catch (e) {
      this.#available = false
      this.#versionText = ""
      this.#log.debug("snapclient: not available: " + (e instanceof Error ? e.message : e))
    }
    if (!this.#available) this.#set("unavailable", "snapclient is not installed")
    else if (this.#state === "unavailable") this.#set("stopped", "")
    else this.#emit()
    return this.#available
  }

  /** `snapclient --player <p> --list` → [{value, label}]. */
  async listSoundcards(player: string): Promise<{ value: string; label: string }[]> {
    if (!this.#available || Model.PLAYERS.indexOf(player) === -1) return []
    try {
      const out = await new Deno.Command(this.#binary, {
        args: ["--player", player, "--list"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        clearEnv: true,
        env: this.#env(),
        signal: AbortSignal.timeout(5000),
      }).output()
      return Model.parseSoundcards(new TextDecoder().decode(out.stdout).slice(0, 64 * 1024))
    } catch {
      return []
    }
  }

  #env(): Record<string, string> {
    // snapclient needs the session's audio server (PipeWire/PulseAudio
    // sockets live under XDG_RUNTIME_DIR) and nothing else.
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin", LANG: "C.UTF-8" }
    try {
      const home = Deno.env.get("HOME")
      if (home) env.HOME = home
      const runtime = Deno.env.get("XDG_RUNTIME_DIR")
      if (runtime) env.XDG_RUNTIME_DIR = runtime
    } catch { /* no env permission */ }
    return env
  }

  async start(opts: LocalOptions): Promise<void> {
    // Validate now so a bad setting is reported instead of crash-looping.
    Model.snapclientArgs(opts, this.#version)
    const changed = JSON.stringify(opts) !== JSON.stringify(this.#opts)
    this.#opts = { ...opts }
    this.#wanted = true
    if (!this.#available && !(await this.detect())) return
    if (this.#child && !changed) return
    this.#attempt = 0
    clearTimeout(this.#restartTimer)
    if (this.#child) await this.#kill()
    this.#spawn()
  }

  async stop(): Promise<void> {
    this.#wanted = false
    clearTimeout(this.#restartTimer)
    await this.#kill()
    if (this.#state !== "unavailable") this.#set("stopped", "")
  }

  #spawn(): void {
    if (!this.#wanted || !this.#opts) return
    let args: string[]
    try {
      args = Model.snapclientArgs(this.#opts, this.#version)
    } catch (e) {
      this.#set("error", e instanceof Error ? e.message : String(e))
      return
    }
    this.#log.info("snapclient: starting (" + args.filter((a) => !a.includes("@")).join(" ") + ")")
    this.#set(this.#attempt === 0 ? "starting" : "restarting", "")
    let child: Deno.ChildProcess
    try {
      child = new Deno.Command(this.#binary, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "piped",
        clearEnv: true,
        env: this.#env(),
      }).spawn()
    } catch (e) {
      this.#set("error", "could not start snapclient: " + (e instanceof Error ? e.message : String(e)))
      this.#scheduleRestart()
      return
    }
    this.#child = child
    this.#startedAt = Date.now()
    this.#pumpStderr(child)
    // Treat it as running once it has stayed up briefly.
    const settle = setTimeout(() => {
      if (this.#child === child) this.#set("running", "")
    }, 1500)
    child.status.then((st) => {
      clearTimeout(settle)
      if (this.#child !== child) return
      this.#child = null
      if (!this.#wanted) return
      const ranFor = Date.now() - this.#startedAt
      if (ranFor > STABLE_MS) this.#attempt = 0
      const why = st.signal ? "signal " + st.signal : "exit " + st.code
      this.#log.warn("snapclient: stopped (" + why + ")" + (this.#lastStderr ? ": " + this.#lastStderr : ""))
      this.#error = "snapclient stopped (" + why + ")" + (this.#lastStderr ? ": " + this.#lastStderr : "")
      this.#scheduleRestart()
    })
  }

  #lastStderr = ""

  async #pumpStderr(child: Deno.ChildProcess): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for await (const chunk of child.stderr) {
        buf += decoder.decode(chunk, { stream: true })
        let nl
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim().slice(0, MAX_STDERR_LINE)
          buf = buf.slice(nl + 1)
          if (line === "") continue
          this.#log.debug("snapclient: " + line)
          if (/error|fail|cannot|unable/i.test(line)) this.#lastStderr = line.slice(0, 200)
        }
        if (buf.length > 64 * 1024) buf = ""
      }
    } catch { /* process ended */ }
  }

  #scheduleRestart(): void {
    if (!this.#wanted) return
    const delay = BACKOFF[Math.min(this.#attempt, BACKOFF.length - 1)]
    this.#attempt++
    this.#set("restarting", this.#error)
    clearTimeout(this.#restartTimer)
    this.#restartTimer = setTimeout(() => this.#spawn(), delay)
  }

  async #kill(): Promise<void> {
    const child = this.#child
    this.#child = null
    if (!child) return
    try {
      child.kill("SIGTERM")
    } catch { /* already gone */ }
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch { /* gone */ }
    }, 3000)
    try {
      await child.status
    } catch { /* ignore */ }
    clearTimeout(t)
  }

  /** Synchronous best-effort kill for helper shutdown. */
  killNow(): void {
    this.#wanted = false
    clearTimeout(this.#restartTimer)
    const child = this.#child
    this.#child = null
    if (child) {
      try {
        child.kill("SIGTERM")
      } catch { /* gone */ }
    }
  }
}
