// Keyring access: the control port is part of the key, so a password saved
// for one server is never sent to another service on the same host.

import { KeyringSecrets, MemorySecrets } from "../helper/secrets.ts"
import { MemoryLogger } from "../helper/log.ts"
import { assertEquals } from "./_assert.ts"

Deno.test("KeyringSecrets passes host, port and user to secret-tool", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const log = dir + "/args"
    const fake = dir + "/secret-tool"
    await Deno.writeTextFile(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + log + '"\ncat >/dev/null\nexit 1\n', { mode: 0o755 })
    const s = new KeyringSecrets(new MemoryLogger(), fake)
    assertEquals(await s.get("snap.lan", 1705, "me"), null)
    await s.set("snap.lan", 1705, "me", "pw").catch(() => {})
    await s.remove("snap.lan", 1705, "me")
    const lines = (await Deno.readTextFile(log)).trim().split("\n")
    assertEquals(lines, [
      "lookup service omarchy-snapcast-ctrl host snap.lan port 1705 user me",
      "store --label=Snapcast me@snap.lan:1705 service omarchy-snapcast-ctrl host snap.lan port 1705 user me",
      "clear service omarchy-snapcast-ctrl host snap.lan port 1705 user me",
    ])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("MemorySecrets keys by host, port and user", async () => {
  const s = new MemorySecrets()
  await s.set("snap.lan", 1705, "me", "pw")
  assertEquals(await s.get("snap.lan", 1705, "me"), "pw")
  assertEquals(await s.get("snap.lan", 1706, "me"), null)
})
