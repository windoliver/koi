import type { ExecutionContext, JsonObject, KoiError, Result, SandboxProfile } from "@koi/core";

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
  readonly durationMs: number;
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
  },
) => IpcProcess;

export type ParseSuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

export type ParseFailure = {
  readonly ok: false;
  readonly error: Error;
};

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;
