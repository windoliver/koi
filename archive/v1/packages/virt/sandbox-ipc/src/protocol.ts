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
  /** Entry file path for dependency-backed bricks (uses import() instead of new Function). */
  readonly entryPath?: string | undefined;
  /** Workspace directory for dependency-backed bricks (chdir before import). */
  readonly workspacePath?: string | undefined;
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
// Internal helper — converts Zod safeParse result to our ParseResult type
// ---------------------------------------------------------------------------

function wrapZodParse<TZod, TOut = TZod>(
  schema: z.ZodType<TZod>,
  raw: unknown,
  transform?: (data: TZod) => TOut,
): ParseResult<TOut> {
  const result = schema.safeParse(raw);
  if (result.success) {
    const data = transform ? transform(result.data) : (result.data as unknown as TOut);
    return { success: true, data };
  }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((i: z.core.$ZodIssue) => ({ message: i.message })),
    },
  };
}

// ---------------------------------------------------------------------------
// Zod schemas (private — never exported)
// ---------------------------------------------------------------------------

const executeSchema = z.object({
  kind: z.literal("execute"),
  code: z.string(),
  input: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().positive(),
  entryPath: z.string().optional(),
  workspacePath: z.string().optional(),
});

const readySchema = z.object({
  kind: z.literal("ready"),
});

const resultSchema = z.object({
  kind: z.literal("result"),
  output: z.unknown(),
  durationMs: z.number().nonnegative(),
  memoryUsedBytes: z.number().nonnegative().optional(),
});

const errorSchema = z.object({
  kind: z.literal("error"),
  code: z.enum(["TIMEOUT", "OOM", "PERMISSION", "CRASH"]),
  message: z.string(),
  durationMs: z.number().nonnegative(),
});

const workerMessageSchema = z.discriminatedUnion("kind", [readySchema, resultSchema, errorSchema]);

// ---------------------------------------------------------------------------
// Transform: strip undefined optional fields (exactOptionalPropertyTypes)
// ---------------------------------------------------------------------------

function cleanResultMessage(d: z.infer<typeof resultSchema>): ResultMessage {
  const { memoryUsedBytes, ...rest } = d;
  return memoryUsedBytes !== undefined ? { ...rest, memoryUsedBytes } : rest;
}

function cleanWorkerMessage(d: z.infer<typeof workerMessageSchema>): WorkerMessage {
  if (d.kind === "result") {
    return cleanResultMessage(d);
  }
  if (d.kind === "ready") {
    return { kind: d.kind };
  }
  return { kind: d.kind, code: d.code, message: d.message, durationMs: d.durationMs };
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

export function parseExecuteMessage(raw: unknown): ParseResult<ExecuteMessage> {
  return wrapZodParse(executeSchema, raw);
}

export function parseWorkerMessage(raw: unknown): ParseResult<WorkerMessage> {
  return wrapZodParse(workerMessageSchema, raw, cleanWorkerMessage);
}

export function parseReadyMessage(raw: unknown): ParseResult<ReadyMessage> {
  return wrapZodParse(readySchema, raw);
}

export function parseResultMessage(raw: unknown): ParseResult<ResultMessage> {
  return wrapZodParse(resultSchema, raw, cleanResultMessage);
}

export function parseErrorMessage(raw: unknown): ParseResult<ErrorMessage> {
  return wrapZodParse(errorSchema, raw);
}
