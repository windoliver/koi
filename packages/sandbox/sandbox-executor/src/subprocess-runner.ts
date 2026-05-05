/**
 * Subprocess runner — executed by SubprocessExecutor in a child Bun process.
 *
 * Protocol (argv-based):
 *   process.argv[2] — absolute path to the code file (.ts or .js)
 *   process.argv[3] — JSON-encoded input value (or "null")
 *
 * Output: the framed result is written to **fd=3** (a dedicated pipe the
 * parent allocates via `stdio: ["ignore", "pipe", "pipe", "pipe"]`). User
 * code is free to write to stdout/stderr without colliding with the
 * protocol — this avoids the race where a tight `process.stderr.write`
 * burst leaves libuv-queued bytes that overrun a stderr-side marker on
 * slow CI runners. fd=3 is touched only by `writeSync` from this runner.
 *
 *   __KOI_RESULT__\n<json>\n
 *   where json is { ok: true, output: unknown } | { ok: false, error: string }
 *
 * Exit codes:
 *   0 — result written to fd=3 (ok or error framed)
 *   1 — unrecoverable startup error (bad argv, parse failure)
 *
 * Backward compatibility: if fd=3 is not available (e.g. older parent or
 * stand-alone invocation), the runner falls back to writing the marker on
 * stderr so existing tests/tools that exec the runner directly still work.
 */

import { writeSync } from "node:fs";

export {};

/** Framing marker separating protocol output from any other content. */
const RESULT_MARKER = "__KOI_RESULT__\n";

/**
 * Result fd: parent allocates fd=3 as a dedicated protocol pipe so user
 * code on stdout/stderr cannot interleave with or race the marker.
 * Falls back to fd=2 (stderr) when fd=3 is unavailable — the parent's
 * `readBoundedText` over stderr still scans the tail buffer for the
 * marker so direct-exec callers (older parent, manual debug runs) keep
 * working.
 */
function resolveResultFd(): number {
  try {
    // writeSync with an empty payload probes the fd without committing data.
    writeSync(3, "");
    return 3;
  } catch (_: unknown) {
    return 2;
  }
}

const RESULT_FD = resolveResultFd();

type RunnerResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: string };

function writeResult(data: RunnerResult): void {
  // Synchronous syscall — bytes are accepted by the kernel before return.
  writeSync(RESULT_FD, `${RESULT_MARKER}${JSON.stringify(data)}\n`);
}

/**
 * Fix 3: type-predicate to check that an unknown import result has a `default`
 * field. Avoids `as` casts when narrowing the dynamic import result.
 */
function hasDefault(m: unknown): m is { readonly default: unknown } {
  return m !== null && typeof m === "object" && "default" in m;
}

async function main(): Promise<void> {
  const codePath = process.argv[2];
  const inputJson = process.argv[3];

  if (codePath === undefined || codePath === "") {
    writeResult({ ok: false, error: "subprocess-runner: missing argv[2] (code path)" });
    process.exit(1);
  }

  if (inputJson === undefined) {
    writeResult({ ok: false, error: "subprocess-runner: missing argv[3] (input JSON)" });
    process.exit(1);
  }

  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch (_: unknown) {
    writeResult({
      ok: false,
      error: `subprocess-runner: failed to parse input JSON: ${inputJson}`,
    });
    process.exit(1);
  }

  // Fix 3: type the import result as `unknown` and use the hasDefault predicate
  // to narrow without casting.
  const mod: unknown = await import(codePath).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    writeResult({ ok: false, error: `subprocess-runner: failed to import module: ${msg}` });
    process.exit(1);
  });

  if (!hasDefault(mod)) {
    writeResult({
      ok: false,
      error: "subprocess-runner: module has no default export",
    });
    process.exit(1);
  }

  if (typeof mod.default !== "function") {
    writeResult({
      ok: false,
      error: "subprocess-runner: module default export must be a function",
    });
    process.exit(1);
  }

  try {
    // `as` cast is unavoidable here: TypeScript cannot narrow `unknown` to a
    // callable type through `typeof fn === "function"` alone. The guard above
    // ensures this is safe at runtime.
    const fn = mod.default as (input: unknown) => unknown | Promise<unknown>;
    const output: unknown = await fn(input);
    writeResult({ ok: true, output });
    // Fix 2: exit 0 after writing success result so any event-loop anchors in
    // user code (setInterval, open handles, dangling promises) do not keep
    // this process alive past the result — which would be misclassified as TIMEOUT.
    process.exit(0);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    writeResult({ ok: false, error: msg });
    process.exit(0);
  }
}

void main();
