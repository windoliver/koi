/**
 * Subprocess runner — executed by the subprocess executor in a child Bun process.
 *
 * Reads JSON input from stdin, dynamically imports the brick's entry module,
 * calls its default export, and writes the result to stderr as JSON with a
 * unique framing marker. stdout is left available for brick user code (e.g.,
 * console.log) and is NOT used for the protocol.
 *
 * Protocol:
 *   stdin  → { "entryPath": string, "input": unknown }
 *   stderr → __KOI_RESULT__<json>\n   (framed protocol output)
 *   stdout → free for brick user code
 *
 * Exit codes:
 *   0 — success (result written to stderr)
 *   1 — execution error (error written to stderr as JSON)
 */

/** Framing marker that separates protocol JSON from any other stderr output. */
const RESULT_MARKER = "__KOI_RESULT__";

function writeProtocol(data: object): void {
  process.stderr.write(`${RESULT_MARKER}${JSON.stringify(data)}\n`);
}

async function main(): Promise<void> {
  // Read all of stdin
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const stdinText = Buffer.concat(chunks).toString("utf8");

  // let justified: payload is parsed from stdin JSON
  let payload: { readonly entryPath: string; readonly input: unknown };
  try {
    payload = JSON.parse(stdinText) as typeof payload;
  } catch (_: unknown) {
    writeProtocol({ ok: false, error: "Failed to parse stdin JSON" });
    process.exit(1);
  }

  try {
    const mod = (await import(payload.entryPath)) as { readonly default?: unknown };
    const fn = mod.default;

    if (typeof fn !== "function") {
      writeProtocol({ ok: false, error: "Brick module must export a default function" });
      process.exit(1);
    }

    const output: unknown = await fn(payload.input);

    writeProtocol({ ok: true, output });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    writeProtocol({ ok: false, error: message });
    process.exit(1);
  }
}

void main();
