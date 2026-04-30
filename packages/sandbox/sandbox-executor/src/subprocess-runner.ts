/**
 * Subprocess runner — executed by SubprocessExecutor in a child Bun process.
 *
 * Protocol (argv-based):
 *   process.argv[2] — absolute path to the code file (.ts or .js)
 *   process.argv[3] — JSON-encoded input value (or "null")
 *
 * Output (stderr, after framing marker):
 *   __KOI_RESULT__\n<json>\n
 *   where json is { ok: true, output: unknown } | { ok: false, error: string }
 *
 * stdout is left free for user code (console.log, etc.).
 *
 * Exit codes:
 *   0 — result written to stderr (ok or error framed)
 *   1 — unrecoverable startup error (bad argv, parse failure)
 */

import { writeSync } from "node:fs";

export {};

/** Framing marker separating protocol output from any other stderr content. */
const RESULT_MARKER = "__KOI_RESULT__\n";

type RunnerResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: string };

function writeResult(data: RunnerResult): void {
  // Use writeSync(fd=2) — a synchronous, unbuffered system call that returns
  // only after the bytes are accepted by the kernel. process.stderr.write does
  // NOT guarantee flush before process.exit(); under heavy stderr backpressure
  // (large prior writes filling the pipe), the framing marker can be lost,
  // causing the parent to mis-classify a successful child as CRASH or TIMEOUT.
  writeSync(2, `${RESULT_MARKER}${JSON.stringify(data)}\n`);
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
