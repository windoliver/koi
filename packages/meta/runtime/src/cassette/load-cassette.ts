import type { Cassette } from "./types.js";

/**
 * Lazy-loads a VCR cassette from the fixtures directory.
 * Uses Bun.file() for native file I/O — no additional dependencies.
 *
 * Validates that the loaded data has the expected shape — all top-level fields
 * plus per-chunk discriminated union fields. Fails fast with a clear error on
 * invalid cassettes rather than producing cryptic type errors in the stream consumer.
 */
export async function loadCassette(fixturePath: string): Promise<Cassette> {
  const file = Bun.file(fixturePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`Cassette not found: ${fixturePath}`);
  }

  const raw: unknown = await file.json();
  validateCassette(raw, fixturePath);
  return raw;
}

function validateCassette(data: unknown, path: string): asserts data is Cassette {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid cassette at ${path}: expected object, got ${typeof data}`);
  }

  const record = data as Record<string, unknown>;
  if (typeof record.name !== "string") {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "name" field`);
  }
  if (typeof record.model !== "string") {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "model" field`);
  }
  if (typeof record.recordedAt !== "number") {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "recordedAt" field`);
  }
  if (!Array.isArray(record.chunks)) {
    throw new Error(`Invalid cassette at ${path}: missing or invalid "chunks" array`);
  }

  const chunks = record.chunks as unknown[];
  for (let i = 0; i < chunks.length; i++) {
    validateChunk(chunks[i], i, path);
  }
}

/**
 * Validates a single chunk against the ModelChunk discriminated union.
 * Checks required fields and primitive types for each kind.
 */
function validateChunk(chunk: unknown, index: number, path: string): void {
  if (typeof chunk !== "object" || chunk === null || !("kind" in chunk)) {
    throw new Error(`Invalid cassette at ${path}: chunks[${index}] missing "kind" field`);
  }

  const record = chunk as Record<string, unknown>;
  const kind = record.kind;
  const prefix = `Invalid cassette at ${path}: chunks[${index}]`;

  switch (kind) {
    case "text_delta":
    case "thinking_delta":
      requireString(record, "delta", prefix);
      break;
    case "tool_call_start":
      requireString(record, "toolName", prefix);
      requireString(record, "callId", prefix);
      break;
    case "tool_call_delta":
      requireString(record, "callId", prefix);
      requireString(record, "delta", prefix);
      break;
    case "tool_call_end":
      requireString(record, "callId", prefix);
      break;
    case "usage":
      requireNumber(record, "inputTokens", prefix);
      requireNumber(record, "outputTokens", prefix);
      break;
    case "error":
      requireString(record, "message", prefix);
      if (record.usage !== undefined) {
        requireObject(record, "usage", prefix);
        {
          const usage = record.usage as Record<string, unknown>;
          requireNumber(usage, "inputTokens", `${prefix} usage`);
          requireNumber(usage, "outputTokens", `${prefix} usage`);
        }
      }
      break;
    case "done":
      requireObject(record, "response", prefix);
      {
        const response = record.response as Record<string, unknown>;
        requireString(response, "content", `${prefix} response`);
        requireString(response, "model", `${prefix} response`);
        if (response.usage !== undefined) {
          requireObject(response, "usage", `${prefix} response`);
          {
            const usage = response.usage as Record<string, unknown>;
            requireNumber(usage, "inputTokens", `${prefix} response usage`);
            requireNumber(usage, "outputTokens", `${prefix} response usage`);
          }
        }
      }
      break;
    default:
      throw new Error(`${prefix} has unknown kind "${String(kind)}"`);
  }
}

function requireString(obj: Record<string, unknown>, field: string, prefix: string): void {
  if (typeof obj[field] !== "string") {
    throw new Error(`${prefix} missing or invalid "${field}" (expected string)`);
  }
}

function requireNumber(obj: Record<string, unknown>, field: string, prefix: string): void {
  if (typeof obj[field] !== "number") {
    throw new Error(`${prefix} missing or invalid "${field}" (expected number)`);
  }
}

function requireObject(obj: Record<string, unknown>, field: string, prefix: string): void {
  if (typeof obj[field] !== "object" || obj[field] === null) {
    throw new Error(`${prefix} missing or invalid "${field}" (expected object)`);
  }
}
