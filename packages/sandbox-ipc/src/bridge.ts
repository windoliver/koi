/**
 * createSandboxBridge() — Core IPC bridge for sandboxed code execution.
 *
 * Spawns a sandboxed Bun child process, sends code over IPC, and returns
 * validated results. Per-request spawn model (one process per execute call).
 *
 * Security properties:
 * - All worker responses validated with Zod schemas before processing
 * - Bridge-level timeout = sandbox timeout + grace period
 * - Result size limit enforced before returning to caller
 * - Process killed on any error path (no zombie processes)
 */

import type { JsonObject, Result } from "@koi/core";
import { buildSandboxCommand } from "@koi/sandbox";
import { createIpcError } from "./errors.js";
import { parseWorkerMessage } from "./protocol.js";
import type {
  BridgeConfig,
  BridgeExecOptions,
  BridgeResult,
  IpcError,
  IpcProcess,
  SandboxBridge,
  SpawnFn,
} from "./types.js";
import { WORKER_SCRIPT } from "./worker-source.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_RESULT_BYTES = 10_485_760; // 10 MB
const DEFAULT_SERIALIZATION = "advanced" as const;
const READY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Default spawn function using Bun.spawn with IPC
// ---------------------------------------------------------------------------

function defaultSpawnFn(
  cmd: readonly string[],
  options: { readonly serialization: "advanced" | "json" },
): IpcProcess {
  const mutableCmd = [...cmd];

  // Handlers must be declared BEFORE Bun.spawn so the ipc callback can dispatch to them.
  const messageHandlers: Array<(message: unknown) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];

  const proc = Bun.spawn(mutableCmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ipc: (message: unknown) => {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
    serialization: options.serialization,
  });

  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal?: number) => proc.kill(signal),
    send: (message: unknown) => {
      proc.send(message);
    },
    onMessage: (handler: (message: unknown) => void) => {
      messageHandlers.push(handler);
    },
    onExit: (handler: (code: number) => void) => {
      exitHandlers.push(handler);
      proc.exited.then((code) => {
        for (const h of exitHandlers) {
          h(code);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Signal name mapping
// ---------------------------------------------------------------------------

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

function signalNameFromExitCode(exitCode: number): string {
  const signalNum = exitCode - 128;
  return SIGNAL_NAMES[signalNum] ?? `SIG${signalNum}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateBridgeOptions {
  readonly config: BridgeConfig;
  /** Injected spawn function for testing. Uses Bun.spawn with IPC by default. */
  readonly spawnFn?: SpawnFn;
}

export async function createSandboxBridge(
  configOrOptions: BridgeConfig | CreateBridgeOptions,
): Promise<SandboxBridge> {
  const options = "config" in configOrOptions ? configOrOptions : { config: configOrOptions };
  const { config } = options;
  const spawnFn = options.spawnFn ?? defaultSpawnFn;

  const serialization = config.serialization ?? DEFAULT_SERIALIZATION;
  const graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
  const defaultMaxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

  // Write worker script to temp file
  const workerId = crypto.randomUUID();
  const workerPath = `/tmp/koi-sandbox-worker-${workerId}.ts`;
  await Bun.write(workerPath, WORKER_SCRIPT);

  let disposed = false;

  async function execute(
    code: string,
    input: JsonObject,
    execOptions?: BridgeExecOptions,
  ): Promise<Result<BridgeResult, IpcError>> {
    if (disposed) {
      return {
        ok: false,
        error: createIpcError("DISPOSED", "Bridge has been disposed"),
      };
    }

    const maxResultBytes = execOptions?.maxResultBytes ?? defaultMaxResultBytes;
    const sandboxTimeoutMs = config.profile.resources.timeoutMs ?? 30_000;
    const requestTimeoutMs = execOptions?.timeoutMs ?? sandboxTimeoutMs;
    const bridgeTimeoutMs = requestTimeoutMs + graceMs;

    // Build sandbox command
    const cmd = buildSandboxCommand(config.profile, "bun", ["run", workerPath]);
    if (!cmd.ok) {
      return {
        ok: false,
        error: createIpcError("SPAWN_FAILED", cmd.error.message),
      };
    }

    const fullCmd = [cmd.value.executable, ...cmd.value.args];

    const startTime = performance.now();

    // Spawn sandboxed process with IPC
    let proc: IpcProcess;
    try {
      proc = spawnFn(fullCmd, { serialization });
    } catch (e: unknown) {
      return {
        ok: false,
        error: createIpcError("SPAWN_FAILED", e instanceof Error ? e.message : String(e), {
          durationMs: performance.now() - startTime,
        }),
      };
    }

    // Race: IPC messages vs bridge timeout vs process exit
    return new Promise<Result<BridgeResult, IpcError>>((resolve) => {
      let settled = false;

      function settle(result: Result<BridgeResult, IpcError>): void {
        if (settled) return;
        settled = true;
        clearTimeout(bridgeTimeout);
        // Kill process if still running — ESRCH expected if already exited
        try {
          proc.kill(9);
        } catch (_e: unknown) {
          // Process already exited (ESRCH) — expected on normal completion
        }
        resolve(result);
      }

      // Bridge-level timeout
      const bridgeTimeout = setTimeout(() => {
        settle({
          ok: false,
          error: createIpcError("TIMEOUT", `Bridge timeout exceeded (${bridgeTimeoutMs}ms)`, {
            durationMs: performance.now() - startTime,
          }),
        });
      }, bridgeTimeoutMs);

      let readyReceived = false;

      // Ready timeout — worker must send "ready" quickly
      const readyTimeout = setTimeout(() => {
        if (!readyReceived) {
          settle({
            ok: false,
            error: createIpcError("CRASH", "Worker did not send ready message within timeout", {
              durationMs: performance.now() - startTime,
            }),
          });
        }
      }, READY_TIMEOUT_MS);

      // Handle process exit before we get a response
      proc.onExit((exitCode: number) => {
        if (settled) return;
        const durationMs = performance.now() - startTime;

        // Exit 137 without timeout → OOM
        if (exitCode === 137) {
          settle({
            ok: false,
            error: createIpcError("OOM", "Worker killed by SIGKILL (likely OOM)", {
              exitCode,
              signal: "SIGKILL",
              durationMs,
            }),
          });
          return;
        }

        // Exit 124 → internal timeout (worker self-terminated)
        if (exitCode === 124) {
          settle({
            ok: false,
            error: createIpcError("TIMEOUT", "Worker self-terminated due to timeout", {
              exitCode,
              durationMs,
            }),
          });
          return;
        }

        // Any other non-zero exit → crash
        if (exitCode !== 0) {
          settle({
            ok: false,
            error: createIpcError("CRASH", `Worker exited with code ${exitCode}`, {
              exitCode,
              ...(exitCode > 128 ? { signal: signalNameFromExitCode(exitCode) } : {}),
              durationMs,
            }),
          });
          return;
        }

        // Exit 0 without a result message → unexpected
        settle({
          ok: false,
          error: createIpcError("CRASH", "Worker exited cleanly without sending result", {
            exitCode: 0,
            durationMs,
          }),
        });
      });

      // Handle IPC messages from worker
      proc.onMessage((raw: unknown) => {
        if (settled) return;

        // Validate with Zod — every message from the sandbox is potentially hostile
        const parsed = parseWorkerMessage(raw);
        if (!parsed.success) {
          settle({
            ok: false,
            error: createIpcError(
              "DESERIALIZE",
              `Invalid worker message: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
              {
                durationMs: performance.now() - startTime,
              },
            ),
          });
          return;
        }

        const msg = parsed.data;

        switch (msg.kind) {
          case "ready": {
            readyReceived = true;
            clearTimeout(readyTimeout);
            // Send execute command to worker
            proc.send({
              kind: "execute",
              code,
              input,
              timeoutMs: requestTimeoutMs,
            });
            break;
          }

          case "result": {
            const durationMs = performance.now() - startTime;

            // Check result size
            const serialized = JSON.stringify(msg.output);
            const sizeBytes = new TextEncoder().encode(serialized).byteLength;
            if (sizeBytes > maxResultBytes) {
              settle({
                ok: false,
                error: createIpcError(
                  "RESULT_TOO_LARGE",
                  `Result size ${sizeBytes} bytes exceeds limit of ${maxResultBytes} bytes`,
                  {
                    durationMs,
                  },
                ),
              });
              return;
            }

            settle({
              ok: true,
              value: {
                output: msg.output,
                durationMs: msg.durationMs,
                ...(msg.memoryUsedBytes !== undefined
                  ? { memoryUsedBytes: msg.memoryUsedBytes }
                  : {}),
                exitCode: 0,
              },
            });
            break;
          }

          case "error": {
            const ipcCode =
              msg.code === "TIMEOUT"
                ? ("TIMEOUT" as const)
                : msg.code === "OOM"
                  ? ("OOM" as const)
                  : ("WORKER_ERROR" as const);

            settle({
              ok: false,
              error: createIpcError(ipcCode, msg.message, {
                durationMs: msg.durationMs,
              }),
            });
            break;
          }
        }
      });
    });
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;

    // Clean up temp worker file
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(workerPath);
    } catch (e: unknown) {
      // Best-effort cleanup — ENOENT is expected if already removed
      const isNotFound = e instanceof Error && "code" in e && e.code === "ENOENT";
      if (!isNotFound) {
        // Log unexpected cleanup failures for debugging
        console.warn(`[sandbox-ipc] Failed to clean up worker file ${workerPath}:`, e);
      }
    }
  }

  return { execute, dispose };
}
