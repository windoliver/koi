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

export function ipcErrorToSandboxError(error: IpcError): SandboxError {
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
  TIMEOUT: true,
  OOM: false,
  CRASH: false,
  SPAWN_FAILED: true,
  DESERIALIZE: false,
  RESULT_TOO_LARGE: false,
  WORKER_ERROR: false,
  DISPOSED: false,
};

export function ipcErrorToKoiError(error: IpcError): KoiError {
  return {
    code: IPC_TO_KOI_CODE[error.code],
    message: `IPC bridge error [${error.code}]: ${error.message}`,
    retryable: IPC_TO_KOI_RETRYABLE[error.code],
  };
}
