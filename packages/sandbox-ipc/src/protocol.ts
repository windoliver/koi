/**
 * IPC message protocol — Zod schemas for messages crossing the IPC boundary.
 *
 * Every message from the sandboxed child is potentially hostile.
 * All messages are validated with Zod before processing.
 *
 * Schemas and Zod types are fully encapsulated. Only plain TypeScript types
 * and validation functions are exported (isolatedDeclarations compatible).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Exported message types (plain TypeScript — no Zod dependency in signatures)
// ---------------------------------------------------------------------------

export interface ExecuteMessage {
  readonly kind: "execute";
  readonly code: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface ReadyMessage {
  readonly kind: "ready";
}

export interface ResultMessage {
  readonly kind: "result";
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
}

export interface ErrorMessage {
  readonly kind: "error";
  readonly code: "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";
  readonly message: string;
  readonly durationMs: number;
}

export type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;

// ---------------------------------------------------------------------------
// Parse result type (replaces z.SafeParseReturnType in public API)
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: { readonly issues: ReadonlyArray<{ readonly message: string }> };
    };

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

export function parseExecuteMessage(raw: unknown): ParseResult<ExecuteMessage> {
  const result = z
    .object({
      kind: z.literal("execute"),
      code: z.string(),
      input: z.record(z.string(), z.unknown()),
      timeoutMs: z.number().positive(),
    })
    .safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((i: z.core.$ZodIssue) => ({ message: i.message })),
    },
  };
}

export function parseWorkerMessage(raw: unknown): ParseResult<WorkerMessage> {
  const result = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("ready") }),
      z.object({
        kind: z.literal("result"),
        output: z.unknown(),
        durationMs: z.number().nonnegative(),
        memoryUsedBytes: z.number().nonnegative().optional(),
      }),
      z.object({
        kind: z.literal("error"),
        code: z.enum(["TIMEOUT", "OOM", "PERMISSION", "CRASH"]),
        message: z.string(),
        durationMs: z.number().nonnegative(),
      }),
    ])
    .safeParse(raw);

  if (result.success) {
    const d = result.data;
    // Handle exactOptionalPropertyTypes: strip undefined optional fields
    if (d.kind === "result") {
      const { memoryUsedBytes, ...rest } = d;
      const data: WorkerMessage =
        memoryUsedBytes !== undefined ? { ...rest, memoryUsedBytes } : rest;
      return { success: true, data };
    }
    // "ready" and "error" variants have no optional fields — safe to construct directly
    const data: WorkerMessage =
      d.kind === "ready"
        ? { kind: d.kind }
        : { kind: d.kind, code: d.code, message: d.message, durationMs: d.durationMs };
    return { success: true, data };
  }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((i: z.core.$ZodIssue) => ({ message: i.message })),
    },
  };
}

export function parseReadyMessage(raw: unknown): ParseResult<ReadyMessage> {
  const result = z
    .object({
      kind: z.literal("ready"),
    })
    .safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((i: z.core.$ZodIssue) => ({ message: i.message })),
    },
  };
}

export function parseResultMessage(raw: unknown): ParseResult<ResultMessage> {
  const result = z
    .object({
      kind: z.literal("result"),
      output: z.unknown(),
      durationMs: z.number().nonnegative(),
      memoryUsedBytes: z.number().nonnegative().optional(),
    })
    .safeParse(raw);

  if (result.success) {
    const { memoryUsedBytes, ...rest } = result.data;
    const data: ResultMessage = memoryUsedBytes !== undefined ? { ...rest, memoryUsedBytes } : rest;
    return { success: true, data };
  }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((i: z.core.$ZodIssue) => ({ message: i.message })),
    },
  };
}

export function parseErrorMessage(raw: unknown): ParseResult<ErrorMessage> {
  const result = z
    .object({
      kind: z.literal("error"),
      code: z.enum(["TIMEOUT", "OOM", "PERMISSION", "CRASH"]),
      message: z.string(),
      durationMs: z.number().nonnegative(),
    })
    .safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((i: z.core.$ZodIssue) => ({ message: i.message })),
    },
  };
}
