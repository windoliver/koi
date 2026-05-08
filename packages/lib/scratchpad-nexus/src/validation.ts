import type { KoiError, ScratchpadPath } from "@koi/core";
import { SCRATCHPAD_DEFAULTS } from "@koi/core";

/**
 * Mirror scratchpad-local's input validation so untrusted user paths/TTLs
 * never cross the RPC boundary. ScratchpadPath is a structural brand (an
 * identity cast), so callers can still construct values that bypass type
 * checks; we re-validate at the trust boundary regardless.
 */
export function validatePath(path: ScratchpadPath): KoiError | null {
  const value = path as string;
  if (!value || value.length === 0) {
    return { code: "VALIDATION", message: "Scratchpad path must not be empty", retryable: false };
  }
  if (value.startsWith("/")) {
    return {
      code: "VALIDATION",
      message: "Scratchpad path must not start with '/'",
      retryable: false,
    };
  }
  if (value.includes("..")) {
    return {
      code: "VALIDATION",
      message: "Scratchpad path must not contain '..'",
      retryable: false,
    };
  }
  if (value.length > SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH) {
    return {
      code: "VALIDATION",
      message: `Scratchpad path exceeds max length of ${SCRATCHPAD_DEFAULTS.MAX_PATH_LENGTH}`,
      retryable: false,
    };
  }
  return null;
}

export function validateTtl(ttlSeconds: number | undefined): KoiError | null {
  if (ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return {
      code: "VALIDATION",
      message: "ttlSeconds must be a finite positive number",
      retryable: false,
    };
  }
  return null;
}

/**
 * Mirror scratchpad-local's metadata clone: round-trip through JSON to
 * reject non-serializable inputs (BigInt, functions, circular structures)
 * at the trust boundary instead of failing deep inside RPC serialization.
 */
export function cloneMetadata(
  metadata: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: KoiError } {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown> };
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Scratchpad metadata is not JSON-serializable",
        retryable: false,
        context: { reason: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

/**
 * Enforce the contract-level entry-size cap before crossing the network so
 * oversized writes fail deterministically here rather than producing
 * vendor-specific errors deep in the transport layer. Matches the local
 * implementation: content bytes + serialized metadata bytes.
 */
export function validateEntrySize(
  content: string,
  metadata: Record<string, unknown> | undefined,
): { ok: true; value: number } | { ok: false; error: KoiError } {
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content).byteLength;
  const metadataBytes =
    metadata !== undefined ? encoder.encode(JSON.stringify(metadata)).byteLength : 0;
  const sizeBytes = contentBytes + metadataBytes;
  if (sizeBytes > SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Entry size ${sizeBytes} exceeds limit ${SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES}`,
        retryable: false,
      },
    };
  }
  return { ok: true, value: sizeBytes };
}
