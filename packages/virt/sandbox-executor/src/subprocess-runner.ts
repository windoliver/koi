/**
 * Subprocess runner — executed by the subprocess executor in a child Bun process.
 *
 * Reads JSON input from stdin, dynamically imports the brick's entry module,
 * calls its default export, and writes the result to stdout as JSON.
 *
 * Protocol:
 *   stdin  → { "entryPath": string, "input": unknown }
 *   stdout → { "ok": true, "output": unknown } | { "ok": false, "error": string }
 *
 * Exit codes:
 *   0 — success (result written to stdout)
 *   1 — execution error (error written to stdout as JSON)
 */

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
    process.stdout.write(JSON.stringify({ ok: false, error: "Failed to parse stdin JSON" }));
    process.exit(1);
  }

  try {
    const mod = (await import(payload.entryPath)) as { readonly default?: unknown };
    const fn = mod.default;

    if (typeof fn !== "function") {
      process.stdout.write(
        JSON.stringify({ ok: false, error: "Brick module must export a default function" }),
      );
      process.exit(1);
    }

    const output: unknown = await fn(payload.input);

    process.stdout.write(JSON.stringify({ ok: true, output }));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  }
}

void main();
