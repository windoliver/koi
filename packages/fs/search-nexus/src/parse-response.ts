/**
 * Defensive response parsers for Nexus search API responses.
 *
 * Uses type guard predicates to avoid `as Type` assertions.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type {
  NexusHealthResponse,
  NexusQueryResponse,
  NexusSearchHit,
  NexusStatsResponse,
} from "./nexus-types.js";

function shapeError(context: string): KoiError {
  return {
    code: "VALIDATION",
    message: `Malformed Nexus response: ${context}`,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isNexusSearchHit(value: unknown): value is NexusSearchHit {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.chunk_text === "string" &&
    typeof value.chunk_index === "number" &&
    typeof value.score === "number"
  );
}

function isNexusQueryResponse(value: unknown): value is NexusQueryResponse {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.hits)) return false;
  if (typeof value.total !== "number") return false;
  if (typeof value.has_more !== "boolean") return false;

  for (const hit of value.hits) {
    if (!isNexusSearchHit(hit)) return false;
  }

  return true;
}

function isNexusHealthResponse(value: unknown): value is NexusHealthResponse {
  if (!isRecord(value)) return false;
  return typeof value.healthy === "boolean";
}

function isNexusStatsResponse(value: unknown): value is NexusStatsResponse {
  if (!isRecord(value)) return false;
  return typeof value.document_count === "number";
}

export function parseNexusQueryResponse(json: unknown): Result<NexusQueryResponse, KoiError> {
  if (!isNexusQueryResponse(json)) {
    return { ok: false, error: shapeError("invalid query response shape") };
  }
  return { ok: true, value: json };
}

export function parseNexusHealthResponse(json: unknown): Result<NexusHealthResponse, KoiError> {
  if (!isNexusHealthResponse(json)) {
    return { ok: false, error: shapeError("invalid health response shape") };
  }
  return { ok: true, value: json };
}

export function parseNexusStatsResponse(json: unknown): Result<NexusStatsResponse, KoiError> {
  if (!isNexusStatsResponse(json)) {
    return { ok: false, error: shapeError("invalid stats response shape") };
  }
  return { ok: true, value: json };
}
