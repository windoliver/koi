/**
 * Worker entry point — bundled into WORKER_SCRIPT by scripts/generate-worker-source.ts.
 *
 * This is the source-of-truth for sandboxed worker behavior. It imports
 * `executeCode` from worker-exec.ts so the core execution logic is
 * testable without evaluating embedded strings.
 *
 * The IPC message validation uses duck-typing (no Zod) to keep the
 * bundle self-contained with zero external dependencies.
 */

import { executeCode, executeEntry } from "./worker-exec.js";

// ---------------------------------------------------------------------------
// IPC send helper — validates IPC is available (no non-null assertion)
// ---------------------------------------------------------------------------

function ipcSend(message: unknown): void {
  if (typeof process.send !== "function") {
    throw new Error("Worker must be spawned with IPC enabled");
  }
  process.send(message);
}

// ---------------------------------------------------------------------------
// Ready signal + message handler
// ---------------------------------------------------------------------------

ipcSend({ kind: "ready" });

let handled = false;

process.on("message", async (raw: unknown) => {
  // Per-request spawn model: only one execute per worker lifetime
  if (handled) {
    ipcSend({
      kind: "error",
      code: "CRASH",
      message: "Worker received duplicate message",
      durationMs: 0,
    });
    return;
  }

  // Duck-type validate message shape (lightweight — no Zod in sandbox)
  if (raw === null || typeof raw !== "object") {
    ipcSend({
      kind: "error",
      code: "CRASH",
      message: "Invalid message: not an object",
      durationMs: 0,
    });
    return;
  }

  const msg = raw as Record<string, unknown>;
  if (msg.kind !== "execute") {
    // Unknown message kind — fail-fast (Chrome CVE-2025-2783 lesson)
    ipcSend({
      kind: "error",
      code: "CRASH",
      message: `Unknown message kind: ${String(msg.kind)}`,
      durationMs: 0,
    });
    return;
  }

  handled = true;

  const code = msg.code;
  const input = msg.input;
  const timeoutMs = msg.timeoutMs;
  const entryPath = msg.entryPath;
  const workspacePath = msg.workspacePath;

  if (
    typeof code !== "string" ||
    typeof input !== "object" ||
    input === null ||
    typeof timeoutMs !== "number"
  ) {
    ipcSend({
      kind: "error",
      code: "CRASH",
      message: "Invalid execute message fields",
      durationMs: 0,
    });
    process.exit(1);
    return;
  }

  const onTimeout = (): void => {
    ipcSend({
      kind: "error",
      code: "TIMEOUT",
      message: "Worker execution timed out",
      durationMs: timeoutMs,
    });
    process.exit(124);
  };

  // Dispatch: entry-path execution for dependency-backed bricks,
  // new Function() for inline code bricks
  const response =
    typeof entryPath === "string" && entryPath.length > 0
      ? await executeEntry(
          entryPath,
          input as Readonly<Record<string, unknown>>,
          timeoutMs,
          typeof workspacePath === "string" ? workspacePath : undefined,
          onTimeout,
        )
      : await executeCode(code, input as Readonly<Record<string, unknown>>, timeoutMs, onTimeout);

  ipcSend(response);
  process.exit(response.kind === "result" ? 0 : 1);
});
