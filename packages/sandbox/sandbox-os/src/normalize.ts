import type { KoiError, Result, SandboxAdapterResult } from "@koi/core";

type ExecResult = SandboxAdapterResult;

function createError(
  code: KoiError["code"],
  message: string,
  durationMs: number,
  context?: KoiError["context"],
): KoiError {
  return {
    code,
    message,
    retryable: code === "TIMEOUT",
    context: {
      durationMs,
      ...(context ?? {}),
    },
  };
}

export function normalizeResult(result: ExecResult): Result<ExecResult, KoiError> {
  if (result.timedOut) {
    return {
      ok: false,
      error: createError("TIMEOUT", "Sandboxed process timed out", result.durationMs),
    };
  }

  if (result.oomKilled) {
    return {
      ok: false,
      error: createError("EXTERNAL", "Sandboxed process was killed due to OOM", result.durationMs, {
        sandboxCode: "OOM",
      }),
    };
  }

  if (result.exitCode === 126 || result.exitCode === 127) {
    return {
      ok: false,
      error: createError(
        "PERMISSION",
        "Sandboxed process could not be executed due to permissions or missing command",
        result.durationMs,
      ),
    };
  }

  if (result.exitCode === 0) {
    return { ok: true, value: result };
  }

  return {
    ok: false,
    error: createError("INTERNAL", "Sandboxed process crashed", result.durationMs, {
      sandboxCode: "CRASH",
      exitCode: result.exitCode,
    }),
  };
}
