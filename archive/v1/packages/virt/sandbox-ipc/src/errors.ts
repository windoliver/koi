/**
 * IPC error creation and adapter functions.
 *
 * Maps IpcError to both SandboxError (forge) and KoiError (core).
 */

import type { KoiError, SandboxError, SandboxErrorCode } from "@koi/core";
import type { IpcError, IpcErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// IPC error factory
// ---------------------------------------------------------------------------

export function createIpcError(
  code: IpcErrorCode,
  message: string,
  details?: {
    readonly exitCode?: number;
    readonly signal?: string;
    readonly durationMs?: number;
  },
): IpcError {
  const base: IpcError = { code, message };
  const exitCode = details?.exitCode;
  const signal = details?.signal;
  const durationMs = details?.durationMs;

  // Build immutably — only include defined fields
  return {
    ...base,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// SandboxError adapter (for forge's SandboxExecutor interface)
// ---------------------------------------------------------------------------

const IPC_TO_SANDBOX_CODE: Readonly<Record<IpcErrorCode, SandboxErrorCode>> = {
  TIMEOUT: "TIMEOUT",
  OOM: "OOM",
  CRASH: "CRASH",
  SPAWN_FAILED: "CRASH",
  DESERIALIZE: "CRASH",
  RESULT_TOO_LARGE: "CRASH",
  WORKER_ERROR: "CRASH",
  DISPOSED: "CRASH",
};

export function mapIpcErrorToSandbox(error: IpcError): SandboxError {
  return {
    code: IPC_TO_SANDBOX_CODE[error.code],
    message: error.message,
    durationMs: error.durationMs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// KoiError adapter (for @koi/core Result<T, KoiError>)
// ---------------------------------------------------------------------------

const IPC_TO_KOI_CODE: Readonly<Record<IpcErrorCode, KoiError["code"]>> = {
  TIMEOUT: "TIMEOUT",
  OOM: "EXTERNAL",
  CRASH: "EXTERNAL",
  SPAWN_FAILED: "EXTERNAL",
  DESERIALIZE: "INTERNAL",
  RESULT_TOO_LARGE: "VALIDATION",
  WORKER_ERROR: "EXTERNAL",
  DISPOSED: "INTERNAL",
};

const IPC_TO_KOI_RETRYABLE: Readonly<Record<IpcErrorCode, boolean>> = {
  TIMEOUT: true, // matches RETRYABLE_DEFAULTS.TIMEOUT
  OOM: false, // matches RETRYABLE_DEFAULTS.EXTERNAL
  CRASH: false, // matches RETRYABLE_DEFAULTS.EXTERNAL
  SPAWN_FAILED: true, // override: transient — worker restart may succeed
  DESERIALIZE: false, // matches RETRYABLE_DEFAULTS.INTERNAL
  RESULT_TOO_LARGE: false, // matches RETRYABLE_DEFAULTS.VALIDATION
  WORKER_ERROR: false, // matches RETRYABLE_DEFAULTS.EXTERNAL
  DISPOSED: false, // matches RETRYABLE_DEFAULTS.INTERNAL
};

export function mapIpcErrorToKoi(error: IpcError): KoiError {
  return {
    code: IPC_TO_KOI_CODE[error.code],
    message: `IPC bridge error [${error.code}]: ${error.message}`,
    retryable: IPC_TO_KOI_RETRYABLE[error.code],
  };
}
