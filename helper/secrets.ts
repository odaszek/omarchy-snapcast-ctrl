// Snapserver password (optional; only for servers with [server] authentication
// enabled). Kept in the Secret Service keyring via `secret-tool`, never in
// shell.json or a plain file.
//
// Attributes: service=omarchy-snapcast-ctrl host=<host> port=<control port> user=<username>
// By hand:    secret-tool store --label="Snapcast" service omarchy-snapcast-ctrl host <host> port <port> user <user>
//
// The control port is part of the key: a password saved for one server is
// never sent to another service on the same host.

import type { Logger } from "./log.ts"

export const SECRET_SERVICE = "omarchy-snapcast-ctrl"

export interface SecretStore {
  get(host: string, port: number, user: string): Promise<string | null>
  set(host: string, port: number, user: string, value: string): Promise<void>
  remove(host: string, port: number, user: string): Promise<void>
}

export class KeyringSecrets implements SecretStore {
  constructor(private log: Logger, private binary = "secret-tool") {}

  async get(host: string, port: number, user: string): Promise<string | null> {
    try {
      const out = await new Deno.Command(this.binary, {
        args: ["lookup", "service", SECRET_SERVICE, "host", host, "port", String(port), "user", user],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      if (!out.success) return null
      const value = new TextDecoder().decode(out.stdout)
      return value.length > 0 ? value : null
    } catch (e) {
      this.log.warn("secret-tool lookup failed: " + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }

  async set(host: string, port: number, user: string, value: string): Promise<void> {
    const child = new Deno.Command(this.binary, {
      args: [
        "store",
        "--label=Snapcast " + user + "@" + host + ":" + port,
        "service",
        SECRET_SERVICE,
        "host",
        host,
        "port",
        String(port),
        "user",
        user,
      ],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    }).spawn()
    const w = child.stdin.getWriter()
    await w.write(new TextEncoder().encode(value))
    await w.close()
    const out = await child.output()
    if (!out.success) throw new Error("secret-tool store failed: " + new TextDecoder().decode(out.stderr).trim().slice(0, 200))
  }

  async remove(host: string, port: number, user: string): Promise<void> {
    try {
      await new Deno.Command(this.binary, {
        args: ["clear", "service", SECRET_SERVICE, "host", host, "port", String(port), "user", user],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output()
    } catch { /* nothing stored */ }
  }
}

/** In-memory store for tests. */
export class MemorySecrets implements SecretStore {
  data = new Map<string, string>()
  get(host: string, port: number, user: string) {
    return Promise.resolve(this.data.get(host + "\n" + port + "\n" + user) ?? null)
  }
  set(host: string, port: number, user: string, value: string) {
    this.data.set(host + "\n" + port + "\n" + user, value)
    return Promise.resolve()
  }
  remove(host: string, port: number, user: string) {
    this.data.delete(host + "\n" + port + "\n" + user)
    return Promise.resolve()
  }
}
