// Minimal assertions so the test suite has no third-party dependencies.

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg)
}

function show(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  const a = show(actual)
  const e = show(expected)
  if (a !== e) throw new Error((msg ? msg + ": " : "") + "expected " + e + "\n     got " + a)
}

export function assertMatch(actual: string, re: RegExp, msg = ""): void {
  if (!re.test(actual)) throw new Error((msg ? msg + ": " : "") + JSON.stringify(actual) + " does not match " + re)
}

export async function assertRejects(fn: () => Promise<unknown>, re?: RegExp): Promise<Error> {
  try {
    await fn()
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    if (re && !re.test(err.message)) throw new Error("rejected with " + JSON.stringify(err.message) + ", expected " + re)
    return err
  }
  throw new Error("expected a rejection")
}

export function assertThrows(fn: () => unknown, re?: RegExp): void {
  try {
    fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (re && !re.test(msg)) throw new Error("threw " + JSON.stringify(msg) + ", expected " + re)
    return
  }
  throw new Error("expected a throw")
}

/** Poll until `fn` returns a truthy value or the timeout expires. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000, what = "condition"): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error("timed out waiting for " + what)
    await new Promise((r) => setTimeout(r, 15))
  }
}
