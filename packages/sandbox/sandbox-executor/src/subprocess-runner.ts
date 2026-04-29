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

export {};

/** Framing marker separating protocol output from any other stderr content. */
const RESULT_MARKER = "__KOI_RESULT__\n";

type RunnerResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: string };

function writeResult(data: RunnerResult): void {
  process.stderr.write(`${RESULT_MARKER}${JSON.stringify(data)}\n`);
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

  let mod: { readonly default?: unknown };
  try {
    mod = (await import(codePath)) as { readonly default?: unknown };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    writeResult({ ok: false, error: `subprocess-runner: failed to import module: ${msg}` });
    process.exit(1);
  }

  const fn = mod.default;
  if (typeof fn !== "function") {
    writeResult({
      ok: false,
      error: "subprocess-runner: module default export must be a function",
    });
    process.exit(1);
  }

  try {
    const output: unknown = await (fn as (input: unknown) => Promise<unknown>)(input);
    writeResult({ ok: true, output });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    writeResult({ ok: false, error: msg });
  }
}

void main();
