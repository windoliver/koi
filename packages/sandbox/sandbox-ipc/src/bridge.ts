import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext, JsonObject, Result, SandboxProfile } from "@koi/core";
import { parseWorkerMessage } from "./protocol.js";
import {
  classifyExitCode,
  createIpcError,
  mapWorkerErrorCode,
  processResultMessage,
} from "./result-classify.js";
import { buildScrubbedEnv, DEFAULT_ENV_ALLOWLIST, defaultSpawnFn } from "./spawn.js";
import type {
  BridgeConfig,
  BridgeExecOptions,
  BridgeResult,
  IpcError,
  IpcErrorCode,
  IpcProcess,
  SandboxBridge,
  SpawnFn,
} from "./types.js";
import { WORKER_SOURCE } from "./worker-source.js";

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_RESULT_BYTES = 10_485_760;
const DEFAULT_SERIALIZATION = "advanced" as const;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CreateSandboxBridgeOptions {
  readonly spawnFn?: SpawnFn;
}

// BridgeConfig.profile is the enforcement ceiling. Per-call ExecutionContext can only
// narrow that ceiling — never broaden network or filesystem allowances. Workspace and
// entry paths must be declared in the bridge profile up front; they are not appended
// from context here. Resource limits are tightened (min) when present in both.
function applyContextToProfile(
  base: SandboxProfile,
  context: ExecutionContext | undefined,
): SandboxProfile {
  if (context === undefined) {
    return base;
  }

  const network = { ...base.network };
  const resources = { ...base.resources };

  if (context.networkAllowed === false) {
    network.allow = false;
  }

  if (context.resourceLimits?.maxMemoryMb !== undefined) {
    const baseMax = base.resources.maxMemoryMb;
    resources.maxMemoryMb =
      baseMax !== undefined
        ? Math.min(baseMax, context.resourceLimits.maxMemoryMb)
        : context.resourceLimits.maxMemoryMb;
  }
  if (context.resourceLimits?.maxPids !== undefined) {
    const baseMax = base.resources.maxPids;
    resources.maxPids =
      baseMax !== undefined
        ? Math.min(baseMax, context.resourceLimits.maxPids)
        : context.resourceLimits.maxPids;
  }

  return {
    ...base,
    network,
    resources,
    ...(context.env !== undefined ? { env: { ...(base.env ?? {}), ...context.env } } : {}),
  };
}

function ensureReadablePath(profile: SandboxProfile, path: string): SandboxProfile {
  const allowRead = profile.filesystem.allowRead ?? [];
  if (allowRead.includes(path)) {
    return profile;
  }

  return {
    ...profile,
    filesystem: {
      ...profile.filesystem,
      allowRead: [...allowRead, path],
    },
  };
}

export async function createSandboxBridge(
  config: BridgeConfig,
  options: CreateSandboxBridgeOptions = {},
): Promise<SandboxBridge> {
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const serialization = config.serialization ?? DEFAULT_SERIALIZATION;
  const graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
  const defaultMaxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const workerPath = join(tmpdir(), `koi-sandbox-ipc-worker-${crypto.randomUUID()}.ts`);

  await Bun.write(workerPath, WORKER_SOURCE);

  let disposed = false;
  const activeProcs = new Set<IpcProcess>();

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

    const requestTimeoutMs =
      execOptions?.timeoutMs ?? config.profile.resources.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Caller's deadline is `requestTimeoutMs`. Grace is reserved for the
    // post-deadline kill→exit drain only (settle()), not for extending the
    // user-visible TIMEOUT clock.
    const bridgeTimeoutMs = requestTimeoutMs;
    const maxResultBytes = execOptions?.maxResultBytes ?? defaultMaxResultBytes;
    const executionProfile = ensureReadablePath(
      applyContextToProfile(config.profile, execOptions?.context),
      workerPath,
    );
    const builtCommand = config.buildCommand(executionProfile, "bun", ["run", workerPath]);

    if (!builtCommand.ok) {
      // Preserve permission/policy denials surfaced by the command builder so
      // the adapter can map them to a non-retryable PERMISSION result instead
      // of a generic CRASH. Other error codes still flow as SPAWN_FAILED.
      const cause = builtCommand.error;
      const ipcCode: IpcErrorCode = cause.code === "PERMISSION" ? "PERMISSION" : "SPAWN_FAILED";
      return {
        ok: false,
        error: createIpcError(ipcCode, cause.message),
      };
    }

    const executeNonce = crypto.randomUUID();

    const scrubbedEnv = buildScrubbedEnv(config.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
    const extraEnv = executionProfile.env ?? {};
    const childEnv: Record<string, string> = { ...scrubbedEnv, ...extraEnv };

    const startedAt = performance.now();
    let proc: IpcProcess;
    try {
      proc = spawnFn([builtCommand.value.executable, ...builtCommand.value.args], {
        serialization,
        env: childEnv,
        processGroupIsolation: config.processGroupIsolation ?? "required",
      });
    } catch (error) {
      return {
        ok: false,
        error: createIpcError(
          "SPAWN_FAILED",
          error instanceof Error ? error.message : String(error),
          { durationMs: performance.now() - startedAt },
        ),
      };
    }

    activeProcs.add(proc);

    const spawnDurationMs = performance.now() - startedAt;

    return await new Promise<Result<BridgeResult, IpcError>>((resolve) => {
      let settled = false;
      let readyReceived = false;

      const settle = (result: Result<BridgeResult, IpcError>): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);

        try {
          proc.kill(9);
        } catch {
          // Best-effort cleanup: the worker may have exited already.
        }

        // Defer resolution until the worker has actually exited. This closes
        // the race where a caller would see TIMEOUT/error and retry while the
        // killed worker was still draining side effects. A `graceMs` fallback
        // prevents the host from hanging if the worker exit promise is stuck.
        let resolvedOnce = false;
        const finalize = (): void => {
          if (resolvedOnce) {
            return;
          }
          resolvedOnce = true;
          activeProcs.delete(proc);
          resolve(result);
        };
        const graceTimer = setTimeout(finalize, graceMs);
        void proc.exited
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(graceTimer);
            finalize();
          });
      };

      const timeoutHandle = setTimeout(() => {
        settle({
          ok: false,
          error: createIpcError("TIMEOUT", `Bridge timeout exceeded (${bridgeTimeoutMs}ms)`, {
            durationMs: performance.now() - startedAt,
          }),
        });
      }, bridgeTimeoutMs);

      proc.onExit((exitCode) => {
        if (settled) {
          return;
        }

        settle({
          ok: false,
          error: classifyExitCode(exitCode, performance.now() - startedAt),
        });
      });

      proc.onMessage((rawMessage) => {
        if (settled) {
          return;
        }

        const parsed = parseWorkerMessage(rawMessage);
        if (!parsed.ok) {
          settle({
            ok: false,
            error: createIpcError("DESERIALIZE", parsed.error.message, {
              durationMs: performance.now() - startedAt,
            }),
          });
          return;
        }

        const message = parsed.value;
        if (message.kind === "ready") {
          if (readyReceived) {
            settle({
              ok: false,
              error: createIpcError("DESERIALIZE", "Worker sent duplicate ready messages", {
                durationMs: performance.now() - startedAt,
              }),
            });
            return;
          }

          readyReceived = true;
          proc.send({
            kind: "execute",
            code,
            input,
            timeoutMs: requestTimeoutMs,
            nonce: executeNonce,
            maxResultBytes,
            serialization,
          });
          return;
        }

        if (message.nonce !== executeNonce) {
          settle({
            ok: false,
            error: createIpcError(
              "DESERIALIZE",
              "Worker terminal frame nonce did not match the expected execute nonce",
              { durationMs: performance.now() - startedAt },
            ),
          });
          return;
        }

        if (!readyReceived) {
          settle({
            ok: false,
            error: createIpcError(
              "DESERIALIZE",
              "Worker sent a terminal message before signaling ready",
              { durationMs: performance.now() - startedAt },
            ),
          });
          return;
        }

        if (message.kind === "result") {
          settle(processResultMessage(message, maxResultBytes, spawnDurationMs, serialization));
          return;
        }

        settle({
          ok: false,
          error: createIpcError(mapWorkerErrorCode(message.code), message.message, {
            durationMs: message.durationMs ?? performance.now() - startedAt,
          }),
        });
      });
    });
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }

    disposed = true;

    // Terminate any in-flight workers before declaring the bridge disposed.
    const procs = Array.from(activeProcs);
    activeProcs.clear();
    const exitWaits: Array<Promise<unknown>> = [];
    for (const proc of procs) {
      try {
        proc.kill(9);
      } catch {
        // Best-effort: worker may have already exited.
      }
      exitWaits.push(proc.exited.catch(() => undefined));
    }
    if (exitWaits.length > 0) {
      await Promise.all(exitWaits);
    }

    try {
      await unlink(workerPath);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return { execute, dispose };
}
