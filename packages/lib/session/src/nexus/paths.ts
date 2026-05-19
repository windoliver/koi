import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export const DEFAULT_NEXUS_SESSION_BASE_PATH = "sessions";

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function validateBasePath(basePath: string): Result<void, KoiError> {
  if (basePath.length === 0) return invalid("basePath cannot be empty");
  if (basePath.includes("..")) return invalid("basePath cannot contain '..'");
  if (basePath.includes("\\")) return invalid("basePath cannot contain '\\'");
  if (basePath.includes("\0")) return invalid("basePath cannot contain null bytes");
  return { ok: true, value: undefined };
}

export function sessionRecordPath(basePath: string, sessionId: string): string {
  return `${basePath}/records/${encodePathSegment(sessionId)}.json`;
}

export function transcriptPath(basePath: string, sessionId: string): string {
  return `${basePath}/transcripts/${encodePathSegment(sessionId)}.jsonl`;
}

export function pendingFramePath(basePath: string, sessionId: string, frameId: string): string {
  return `${basePath}/pending/${encodePathSegment(sessionId)}/${encodePathSegment(frameId)}.json`;
}

export function contentReplacementPath(
  basePath: string,
  sessionId: string,
  messageId: string,
): string {
  return `${basePath}/content-replacements/${encodePathSegment(sessionId)}/${encodePathSegment(messageId)}.json`;
}

export function artifactPath(basePath: string, sessionId: string, artifactId: string): string {
  return `${basePath}/artifacts/${encodePathSegment(sessionId)}/${encodePathSegment(artifactId)}.json`;
}

function invalid(message: string): Result<void, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
