/**
 * Embedded worker script — written to a temp file and executed inside the sandbox.
 *
 * This is a self-contained Bun script string. It runs as a child process with IPC
 * enabled. The worker:
 * 1. Sends { kind: "ready" } on startup
 * 2. Listens for IPC messages via process.on("message", ...)
 * 3. Validates messages (fail-fast on unknown kinds)
 * 4. Executes code via new Function() (OS sandbox is the trust boundary)
 * 5. Sends result or error back via process.send()
 *
 * Security: Unknown message kinds are logged and ignored (Chrome CVE-2025-2783 lesson).
 */

export const WORKER_SCRIPT = `
"use strict";

// ---- Internal timeout watchdog ----
// Worker kills itself if total execution exceeds a generous limit.
// The per-request timeout is handled by the execute flow.

process.send({ kind: "ready" });

let handled = false;

process.on("message", async (raw) => {
  // Only handle one execute message per worker lifetime (per-request spawn model)
  if (handled) {
    process.send({ kind: "error", code: "CRASH", message: "Worker received duplicate message", durationMs: 0 });
    return;
  }

  // Validate message shape
  if (raw === null || typeof raw !== "object") {
    process.send({ kind: "error", code: "CRASH", message: "Invalid message: not an object", durationMs: 0 });
    return;
  }

  const msg = raw;
  if (msg.kind !== "execute") {
    // Unknown message kind — log and ignore (fail-fast per Chrome CVE lesson)
    process.send({ kind: "error", code: "CRASH", message: "Unknown message kind: " + String(msg.kind), durationMs: 0 });
    return;
  }

  handled = true;

  const code = msg.code;
  const input = msg.input;
  const timeoutMs = msg.timeoutMs;

  if (typeof code !== "string" || typeof input !== "object" || input === null || typeof timeoutMs !== "number") {
    process.send({ kind: "error", code: "CRASH", message: "Invalid execute message fields", durationMs: 0 });
    process.exit(1);
    return;
  }

  // Internal timeout watchdog — worker kills itself if execution exceeds deadline
  const watchdog = setTimeout(() => {
    process.send({ kind: "error", code: "TIMEOUT", message: "Worker execution timed out", durationMs: timeoutMs });
    process.exit(124);
  }, timeoutMs);

  const startTime = performance.now();

  try {
    const fn = new Function("input", code);
    const result = await Promise.resolve(fn(input));
    const durationMs = performance.now() - startTime;
    clearTimeout(watchdog);

    process.send({ kind: "result", output: result, durationMs });
    process.exit(0);
  } catch (e) {
    const durationMs = performance.now() - startTime;
    clearTimeout(watchdog);

    const message = e instanceof Error ? e.message : String(e);
    let errorCode = "CRASH";

    if (message.includes("Permission denied") || message.includes("EACCES")) {
      errorCode = "PERMISSION";
    }

    process.send({ kind: "error", code: errorCode, message, durationMs });
    process.exit(1);
  }
});
`;
