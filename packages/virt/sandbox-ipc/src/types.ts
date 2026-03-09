/**
 * Core types for @koi/sandbox-ipc — IPC bridge between host and sandboxed workers.
 *
 * Types only, zero runtime code.
 */

import type { ExecutionContext, JsonObject, KoiError, Result, SandboxProfile } from "@koi/core";

// ---------------------------------------------------------------------------
// Command builder — injected dependency (avoids L2→L2 import of @koi/sandbox)
// ---------------------------------------------------------------------------

export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export type CommandBuilder = (
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
) => Result<SandboxCommand, KoiError>;

// ---------------------------------------------------------------------------
// Bridge configuration
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  readonly profile: SandboxProfile;
  /** Injected command builder — translates profile + command into sandboxed invocation. */
  readonly buildCommand: CommandBuilder;
  /** Serialization format for Bun IPC. Default: "advanced" (JSC structured clone). */
  readonly serialization?: "advanced" | "json";
  /** Grace period (ms) added to sandbox timeout for bridge-level timeout. Default: 5000. */
  readonly graceMs?: number;
  /** Maximum IPC result size in bytes. Default: 10_485_760 (10 MB). */
  readonly maxResultBytes?: number;
}

// ---------------------------------------------------------------------------
// Bridge execution options and result
// ---------------------------------------------------------------------------

export interface BridgeExecOptions {
  readonly timeoutMs?: number;
  readonly maxResultBytes?: number;
  /** Execution context for per-brick workspace, network, and resource overrides. */
  readonly context?: ExecutionContext | undefined;
}

export interface BridgeResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
  readonly exitCode: number;
  /** Time from bridge.execute() entry to IPC process spawn completion (ms). */
  readonly spawnDurationMs?: number;
}

// ---------------------------------------------------------------------------
// SandboxBridge — full IPC lifecycle
// ---------------------------------------------------------------------------

export interface SandboxBridge {
  readonly execute: (
    code: string,
    input: JsonObject,
    options?: BridgeExecOptions,
  ) => Promise<Result<BridgeResult, IpcError>>;
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// IPC error types
// ---------------------------------------------------------------------------

export type IpcErrorCode =
  | "TIMEOUT"
  | "OOM"
  | "CRASH"
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

// ---------------------------------------------------------------------------
// Internal: process spawn abstraction (for testing via dependency injection)
// ---------------------------------------------------------------------------

export interface IpcProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
  readonly send: (message: unknown) => void;
  readonly onMessage: (handler: (message: unknown) => void) => void;
  readonly onExit: (handler: (code: number) => void) => void;
}

export type SpawnFn = (
  cmd: readonly string[],
  options: {
    readonly serialization: "advanced" | "json";
  },
) => IpcProcess;
