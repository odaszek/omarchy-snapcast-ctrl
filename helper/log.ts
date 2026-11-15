// Diagnostics log: stderr plus a size-capped file in <state>/logs/helper.log.
// Log output stays in English (Omarchy convention for diagnostics).

export type Level = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_MESSAGE = 2000

export class FileLogger implements Logger {
  #file: string | null
  #size = 0
  #sinks: ((level: Level, message: string) => void)[] = []
  #verbose: boolean

  constructor(dir: string | null, verbose = false) {
    this.#verbose = verbose
    this.#file = null
    if (dir) {
      try {
        Deno.mkdirSync(dir, { recursive: true, mode: 0o700 })
        this.#file = dir + "/helper.log"
        try {
          this.#size = Deno.statSync(this.#file).size
        } catch {
          this.#size = 0
        }
      } catch {
        this.#file = null
      }
    }
  }

  onLog(sink: (level: Level, message: string) => void): void {
    this.#sinks.push(sink)
  }

  debug(message: string): void {
    if (this.#verbose) this.#write("debug", message)
  }
  info(message: string): void {
    this.#write("info", message)
  }
  warn(message: string): void {
    this.#write("warn", message)
  }
  error(message: string): void {
    this.#write("error", message)
  }

  #write(level: Level, message: string): void {
    // Strip control characters so server-supplied text cannot forge log lines.
    // deno-lint-ignore no-control-regex
    const clean = String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?").slice(0, MAX_MESSAGE)
    const line = new Date().toISOString() + " " + level.toUpperCase() + " " + clean.replace(/\n/g, "\n    ") + "\n"
    try {
      Deno.stderr.writeSync(new TextEncoder().encode(line))
    } catch { /* stderr closed */ }
    if (this.#file) {
      try {
        if (this.#size + line.length > MAX_FILE_BYTES) {
          try {
            Deno.renameSync(this.#file, this.#file + ".1")
          } catch { /* first rotation */ }
          this.#size = 0
        }
        Deno.writeTextFileSync(this.#file, line, { append: true, mode: 0o600 })
        this.#size += line.length
      } catch { /* logging must never fail the caller */ }
    }
    for (const sink of this.#sinks) {
      try {
        sink(level, clean)
      } catch { /* ignore */ }
    }
  }
}

/** Logger for tests: keeps lines in memory. */
export class MemoryLogger implements Logger {
  lines: string[] = []
  debug(m: string) {
    this.lines.push("debug: " + m)
  }
  info(m: string) {
    this.lines.push("info: " + m)
  }
  warn(m: string) {
    this.lines.push("warn: " + m)
  }
  error(m: string) {
    this.lines.push("error: " + m)
  }
}
