import type { ExecutionContext, JsonObject, KoiError, Result, SandboxProfile } from "@koi/core";
import type { SandboxIpcParseError } from "./errors.js";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SandboxIpcErrorCode = "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";

export interface ReadyMessage {
  readonly kind: "ready";
}

export interface ExecuteMessage {
  readonly kind: "execute";
  readonly code: string;
  readonly input: JsonValue;
  readonly timeoutMs: number;
  /** Per-call random nonce. Worker echoes this on every terminal frame. */
  readonly nonce: string;
  /** Optional worker-side cap on serialized result bytes. */
  readonly maxResultBytes?: number;
  /** Transport serialization mode the worker should account for in the cap. */
  readonly serialization?: "advanced" | "json";
}

export interface ResultMessage {
  readonly kind: "result";
  readonly output?: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
}

export interface ErrorMessage {
  readonly kind: "error";
  readonly code: SandboxIpcErrorCode;
  readonly message: string;
  readonly durationMs?: number;
}

export type HostMessage = ExecuteMessage;

export type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;

export type SandboxIpcMessage = HostMessage | WorkerMessage;

export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export type CommandBuilder = (
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
) => Result<SandboxCommand, KoiError>;

export interface BridgeConfig {
  readonly profile: SandboxProfile;
  readonly buildCommand: CommandBuilder;
  readonly serialization?: "advanced" | "json";
  readonly graceMs?: number;
  readonly maxResultBytes?: number;
  /**
   * Process-group isolation policy for the default spawn implementation.
   * Default: "required" — the bridge refuses to spawn workers when `setsid`
   * is not on `PATH`, so descendant processes spawned by untrusted code can
   * always be torn down via group kill on timeout/dispose. Set to
   * "best-effort" only when callers consciously accept descendant-leak risk
   * (e.g., dev hosts without util-linux); the bridge then falls back to
   * killing only the direct worker.
   */
  readonly processGroupIsolation?: "required" | "best-effort";
  /**
   * Optional environment-variable allowlist for the default spawn
   * implementation. Untrusted workers receive only the variables listed here
   * (intersected with the host environment). When omitted, a minimal default
   * (PATH, HOME, USER, TMPDIR, LANG, LC_ALL) is used.
   */
  readonly envAllowlist?: readonly string[];
}

export interface BridgeExecOptions {
  readonly timeoutMs?: number;
  readonly maxResultBytes?: number;
  readonly context?: ExecutionContext | undefined;
}

export interface BridgeResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
  readonly exitCode: number;
  readonly spawnDurationMs?: number;
}

export type IpcErrorCode =
  | SandboxIpcErrorCode
  | "SPAWN_FAILED"
  | "DESERIALIZE"
  | "RESULT_TOO_LARGE"
  | "WORKER_ERROR"
  | "DISPOSED";

export interface IpcError {
  readonly code: IpcErrorCode;
  readonly message: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly durationMs?: number;
}

export interface SandboxBridge {
  readonly execute: (
    code: string,
    input: JsonObject,
    options?: BridgeExecOptions,
  ) => Promise<Result<BridgeResult, IpcError>>;
  readonly dispose: () => Promise<void>;
}

export interface IpcProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
  readonly send: (message: unknown) => void;
  readonly onMessage: (handler: (message: unknown) => void) => void;
  readonly onExit: (handler: (code: number) => void) => void;
}

export type SpawnFn = (
  command: readonly string[],
  options: {
    readonly serialization: "advanced" | "json";
    readonly env?: Readonly<Record<string, string>>;
    readonly processGroupIsolation?: "required" | "best-effort";
  },
) => IpcProcess;

export type ParseSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

export type ParseFailure = {
  readonly ok: false;
  readonly error: SandboxIpcParseError;
};

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;
