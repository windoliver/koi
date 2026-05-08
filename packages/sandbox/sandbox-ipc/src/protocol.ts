import { createSandboxIpcParseError } from "./errors.js";
import type {
  ErrorMessage,
  ExecuteMessage,
  JsonValue,
  ParseResult,
  ReadyMessage,
  ResultMessage,
  SandboxIpcErrorCode,
  WorkerMessage,
} from "./types.js";

const ERROR_CODES: readonly SandboxIpcErrorCode[] = ["TIMEOUT", "OOM", "PERMISSION", "CRASH"];

type RecordValue = Record<string, unknown>;

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail<T>(path: string, reason: string): ParseResult<T> {
  return { ok: false, error: createSandboxIpcParseError(path, reason) };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObjectRecord(value: unknown): value is RecordValue {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  if (!isPlainObjectRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => isJsonValue(entry));
}

function expectRecord(value: unknown): ParseResult<RecordValue> {
  if (!isRecord(value)) {
    return fail("$", "expected an object");
  }
  return ok(value);
}

function expectKind(record: RecordValue, kind: string): ParseResult<void> {
  if (record.kind !== kind) {
    return fail("kind", `expected "${kind}"`);
  }
  return ok(undefined);
}

function expectString(record: RecordValue, key: string): ParseResult<string> {
  const value = record[key];
  if (typeof value !== "string") {
    return fail(key, "expected a string");
  }
  return ok(value);
}

function expectJsonValue(record: RecordValue, key: string): ParseResult<JsonValue> {
  if (!hasOwn(record, key)) {
    return fail(key, "expected a JSON value");
  }
  const value = record[key];
  if (!isJsonValue(value)) {
    return fail(key, "expected a JSON value");
  }
  return ok(value);
}

function expectNonNegativeNumber(record: RecordValue, key: string): ParseResult<number> {
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    return fail(key, "expected a non-negative number");
  }
  return ok(value);
}

function expectPositiveNumber(record: RecordValue, key: string): ParseResult<number> {
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return fail(key, "expected a positive number");
  }
  return ok(value);
}

function expectOptionalNonNegativeNumber(
  record: RecordValue,
  key: string,
): ParseResult<number | undefined> {
  if (!hasOwn(record, key) || record[key] === undefined) {
    return ok(undefined);
  }
  return expectNonNegativeNumber(record, key);
}

function expectErrorCode(record: RecordValue): ParseResult<SandboxIpcErrorCode> {
  const value = record.code;
  if (typeof value !== "string" || !ERROR_CODES.includes(value as SandboxIpcErrorCode)) {
    return fail("code", "expected a supported sandbox IPC error code");
  }
  return ok(value as SandboxIpcErrorCode);
}

export function parseReadyMessage(value: unknown): ParseResult<ReadyMessage> {
  const record = expectRecord(value);
  if (!record.ok) return record;

  const kind = expectKind(record.value, "ready");
  if (!kind.ok) return kind;

  return ok({ kind: "ready" });
}

function expectNonEmptyString(record: RecordValue, key: string): ParseResult<string> {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return fail(key, "expected a non-empty string");
  }
  return ok(value);
}

function expectOptionalPositiveNumber(
  record: RecordValue,
  key: string,
): ParseResult<number | undefined> {
  if (!hasOwn(record, key) || record[key] === undefined) {
    return ok(undefined);
  }
  return expectPositiveNumber(record, key);
}

function expectOptionalSerialization(
  record: RecordValue,
): ParseResult<"advanced" | "json" | undefined> {
  if (!hasOwn(record, "serialization") || record.serialization === undefined) {
    return ok(undefined);
  }
  if (record.serialization !== "advanced" && record.serialization !== "json") {
    return fail("serialization", 'expected "advanced" or "json"');
  }
  return ok(record.serialization);
}

export function parseExecuteMessage(value: unknown): ParseResult<ExecuteMessage> {
  const record = expectRecord(value);
  if (!record.ok) return record;

  const kind = expectKind(record.value, "execute");
  if (!kind.ok) return kind;

  const code = expectString(record.value, "code");
  if (!code.ok) return code;

  const input = expectJsonValue(record.value, "input");
  if (!input.ok) return input;

  const timeoutMs = expectPositiveNumber(record.value, "timeoutMs");
  if (!timeoutMs.ok) return timeoutMs;

  const nonce = expectNonEmptyString(record.value, "nonce");
  if (!nonce.ok) return nonce;

  const maxResultBytes = expectOptionalPositiveNumber(record.value, "maxResultBytes");
  if (!maxResultBytes.ok) return maxResultBytes;

  const serialization = expectOptionalSerialization(record.value);
  if (!serialization.ok) return serialization;

  return ok({
    kind: "execute",
    code: code.value,
    input: input.value,
    timeoutMs: timeoutMs.value,
    nonce: nonce.value,
    ...(maxResultBytes.value !== undefined ? { maxResultBytes: maxResultBytes.value } : {}),
    ...(serialization.value !== undefined ? { serialization: serialization.value } : {}),
  });
}

export function parseResultMessage(value: unknown): ParseResult<ResultMessage> {
  const record = expectRecord(value);
  if (!record.ok) return record;

  const kind = expectKind(record.value, "result");
  if (!kind.ok) return kind;

  const durationMs = expectNonNegativeNumber(record.value, "durationMs");
  if (!durationMs.ok) return durationMs;

  const memoryUsedBytes = expectOptionalNonNegativeNumber(record.value, "memoryUsedBytes");
  if (!memoryUsedBytes.ok) return memoryUsedBytes;

  const base = {
    kind: "result" as const,
    durationMs: durationMs.value,
    ...(memoryUsedBytes.value !== undefined ? { memoryUsedBytes: memoryUsedBytes.value } : {}),
  };

  if (!hasOwn(record.value, "output")) {
    return ok(base);
  }

  return ok({
    ...base,
    output: record.value.output,
  });
}

export function parseErrorMessage(value: unknown): ParseResult<ErrorMessage> {
  const record = expectRecord(value);
  if (!record.ok) return record;

  const kind = expectKind(record.value, "error");
  if (!kind.ok) return kind;

  const code = expectErrorCode(record.value);
  if (!code.ok) return code;

  const message = expectString(record.value, "message");
  if (!message.ok) return message;

  const durationMs = expectOptionalNonNegativeNumber(record.value, "durationMs");
  if (!durationMs.ok) return durationMs;

  return ok({
    kind: "error",
    code: code.value,
    message: message.value,
    ...(durationMs.value !== undefined ? { durationMs: durationMs.value } : {}),
  });
}

export function parseWorkerMessage(value: unknown): ParseResult<WorkerMessage> {
  const record = expectRecord(value);
  if (!record.ok) return record;

  const kind = record.value.kind;
  if (kind === "ready") {
    return parseReadyMessage(record.value);
  }
  if (kind === "result") {
    return parseResultMessage(record.value);
  }
  if (kind === "error") {
    return parseErrorMessage(record.value);
  }

  return fail("kind", 'expected one of "ready", "result", or "error"');
}
