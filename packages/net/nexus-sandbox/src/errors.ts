/**
 * Typed KoiError factories for @koi/nexus-sandbox.
 *
 * Codes map to the @koi/core taxonomy — no custom codes. Callers
 * differentiate via `context` keys when needed.
 */

import type { KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function healthTimeoutError(baseUrl: string, timeoutMs: number): KoiError {
  return {
    code: "TIMEOUT",
    message: `Nexus sandbox health check timed out after ${String(timeoutMs)}ms — server did not respond on ${baseUrl}/health`,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
    context: { baseUrl, timeoutMs },
  };
}

export function portInUseError(port: number): KoiError {
  return {
    code: "CONFLICT",
    message: `Port ${String(port)} is already in use — another nexus or service is bound to it. Pick a different port or stop the conflicting process.`,
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
    context: { port },
  };
}

export interface SpawnFailureContext {
  readonly exitCode?: number | undefined;
  readonly stderr?: string | undefined;
  readonly cause?: unknown;
}

export function spawnFailedError(ctx: SpawnFailureContext): KoiError {
  const reason =
    ctx.exitCode !== undefined
      ? `nexus sandbox subprocess exited with code ${String(ctx.exitCode)} during spawn`
      : `failed to spawn nexus sandbox subprocess`;
  const hint = ctx.stderr ? ` — stderr: ${ctx.stderr.slice(0, 240)}` : "";
  const error: KoiError = {
    code: "EXTERNAL",
    message: `${reason}${hint}. Check that 'uvx' is installed (https://docs.astral.sh/uv/) or set NEXUS_COMMAND.`,
    retryable: RETRYABLE_DEFAULTS.EXTERNAL,
    context: {
      ...(ctx.exitCode !== undefined ? { exitCode: ctx.exitCode } : {}),
      ...(ctx.stderr ? { stderr: ctx.stderr } : {}),
    },
    ...(ctx.cause !== undefined ? { cause: ctx.cause } : {}),
  };
  return error;
}

export function shutdownTimeoutError(pid: number, drainMs: number): KoiError {
  return {
    code: "TIMEOUT",
    message: `Nexus sandbox subprocess (pid ${String(pid)}) did not exit within ${String(drainMs)}ms after SIGTERM — SIGKILL sent.`,
    retryable: false,
    context: { pid, drainMs },
  };
}
