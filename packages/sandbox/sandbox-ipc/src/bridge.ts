import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import type { ExecutionContext, JsonObject, Result, SandboxProfile } from "@koi/core";
import { parseWorkerMessage } from "./protocol.js";
import type {
  BridgeConfig,
  BridgeExecOptions,
  BridgeResult,
  ErrorMessage,
  IpcError,
  IpcErrorCode,
  IpcProcess,
  ResultMessage,
  SandboxBridge,
  SpawnFn,
} from "./types.js";
import { WORKER_SOURCE } from "./worker-source.js";

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_RESULT_BYTES = 10_485_760;
const DEFAULT_SERIALIZATION = "advanced" as const;
const DEFAULT_TIMEOUT_MS = 30_000;

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

export interface CreateSandboxBridgeOptions {
  readonly spawnFn?: SpawnFn;
}

function createIpcError(
  code: IpcErrorCode,
  message: string,
  details?: {
    readonly exitCode?: number;
    readonly signal?: string;
    readonly durationMs?: number;
  },
): IpcError {
  return {
    code,
    message,
    ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
    ...(details?.signal !== undefined ? { signal: details.signal } : {}),
    ...(details?.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
  };
}

function signalNameFromNumber(signal: number | undefined): string | undefined {
  if (signal === undefined) {
    return undefined;
  }
  return SIGNAL_NAMES[signal] ?? `SIG${signal}`;
}

function classifyExitCode(exitCode: number, durationMs: number): IpcError {
  if (exitCode === 137) {
    return createIpcError("OOM", "Worker killed by SIGKILL (likely OOM)", {
      exitCode,
      signal: "SIGKILL",
      durationMs,
    });
  }

  if (exitCode === 124) {
    return createIpcError("TIMEOUT", "Worker self-terminated due to timeout", {
      exitCode,
      durationMs,
    });
  }

  if (exitCode !== 0) {
    const signal = exitCode > 128 ? signalNameFromNumber(exitCode - 128) : undefined;
    return createIpcError("CRASH", `Worker exited with code ${exitCode}`, {
      exitCode,
      ...(signal !== undefined ? { signal } : {}),
      durationMs,
    });
  }

  return createIpcError("CRASH", "Worker exited cleanly without sending a terminal message", {
    exitCode,
    durationMs,
  });
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

function mapWorkerErrorCode(code: ErrorMessage["code"]): IpcErrorCode {
  switch (code) {
    case "TIMEOUT":
      return "TIMEOUT";
    case "OOM":
      return "OOM";
    case "PERMISSION":
      return "PERMISSION";
    case "CRASH":
      return "WORKER_ERROR";
  }
}

function processResultMessage(
  message: ResultMessage,
  maxResultBytes: number,
  spawnDurationMs: number,
  serialization: "advanced" | "json",
): Result<BridgeResult, IpcError> {
  let sizeBytes: number;
  try {
    if (serialization === "advanced") {
      sizeBytes = serialize(message.output).byteLength;
    } else {
      const serialized = JSON.stringify(message.output ?? null);
      sizeBytes = Buffer.byteLength(serialized, "utf8");
    }
  } catch (error) {
    return {
      ok: false,
      error: createIpcError(
        "DESERIALIZE",
        `Result could not be serialized for ${serialization} IPC: ${error instanceof Error ? error.message : String(error)}`,
        { durationMs: message.durationMs },
      ),
    };
  }

  if (sizeBytes > maxResultBytes) {
    return {
      ok: false,
      error: createIpcError(
        "RESULT_TOO_LARGE",
        `Result size ${sizeBytes} bytes exceeds limit of ${maxResultBytes} bytes`,
        { durationMs: message.durationMs },
      ),
    };
  }

  return {
    ok: true,
    value: {
      output: message.output,
      durationMs: message.durationMs,
      ...(message.memoryUsedBytes !== undefined
        ? { memoryUsedBytes: message.memoryUsedBytes }
        : {}),
      exitCode: 0,
      spawnDurationMs,
    },
  };
}

function drainStream(stream: ReadableStream<Uint8Array> | null): void {
  if (stream === null) {
    return;
  }

  void stream
    .pipeTo(
      new WritableStream<Uint8Array>({
        write() {
          // Discard child stdio without buffering it in host memory.
        },
      }),
    )
    .catch(() => {});
}

let detectedSetsidPath: string | null | undefined;

function detectSetsid(): string | null {
  if (detectedSetsidPath !== undefined) {
    return detectedSetsidPath;
  }
  if (process.platform !== "linux" && process.platform !== "darwin") {
    detectedSetsidPath = null;
    return null;
  }
  try {
    detectedSetsidPath = Bun.which("setsid");
  } catch {
    detectedSetsidPath = null;
  }
  return detectedSetsidPath ?? null;
}

function defaultSpawnFn(
  command: readonly string[],
  options: {
    readonly serialization: "advanced" | "json";
  },
): IpcProcess {
  const messageHandlers: Array<(message: unknown) => void> = [];
  const setsidPath = detectSetsid();
  const useGroup = setsidPath !== null;
  const spawnArgv: string[] = useGroup ? [setsidPath, "-w", ...command] : [...command];

  const proc = Bun.spawn(spawnArgv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    serialization: options.serialization,
    ipc(message: unknown) {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
  });

  drainStream(proc.stdout);
  drainStream(proc.stderr);

  function killGroup(signalName: NodeJS.Signals): void {
    if (useGroup) {
      try {
        // Negative pid signals the entire process group, terminating any
        // descendants the worker spawned.
        process.kill(-proc.pid, signalName);
        return;
      } catch {
        // Fallthrough to direct kill if the group is already gone.
      }
    }
    proc.kill(signalName);
  }

  return {
    pid: proc.pid,
    exited: proc.exited,
    kill(signal?: number) {
      const signalName = (signalNameFromNumber(signal ?? 15) ?? "SIGTERM") as NodeJS.Signals;
      killGroup(signalName);
    },
    send(message: unknown) {
      proc.send(message);
    },
    onMessage(handler: (message: unknown) => void) {
      messageHandlers.push(handler);
    },
    onExit(handler: (code: number) => void) {
      void proc.exited.then((code) => {
        handler(code);
      });
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
    const bridgeTimeoutMs = requestTimeoutMs + graceMs;
    const maxResultBytes = execOptions?.maxResultBytes ?? defaultMaxResultBytes;
    const executionProfile = ensureReadablePath(
      applyContextToProfile(config.profile, execOptions?.context),
      workerPath,
    );
    const builtCommand = config.buildCommand(executionProfile, "bun", ["run", workerPath]);

    if (!builtCommand.ok) {
      return {
        ok: false,
        error: createIpcError("SPAWN_FAILED", builtCommand.error.message),
      };
    }

    const executeNonce = crypto.randomUUID();

    const startedAt = performance.now();
    let proc: IpcProcess;
    try {
      proc = spawnFn([builtCommand.value.executable, ...builtCommand.value.args], {
        serialization,
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
        activeProcs.delete(proc);

        try {
          proc.kill(9);
        } catch {
          // Best-effort cleanup: the worker may have exited already.
        }

        resolve(result);
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

        const rawNonce =
          typeof rawMessage === "object" &&
          rawMessage !== null &&
          !Array.isArray(rawMessage) &&
          "nonce" in rawMessage
            ? (rawMessage as { nonce?: unknown }).nonce
            : undefined;
        if (rawNonce !== executeNonce) {
          settle({
            ok: false,
            error: createIpcError(
              "DESERIALIZE",
              "Worker terminal frame missing or with invalid nonce",
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
