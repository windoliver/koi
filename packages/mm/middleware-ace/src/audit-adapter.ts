/**
 * Audit → ACE adapter — transforms AuditEntry data into RichTrajectoryStep
 * for the ACE LLM pipeline (reflector + curator).
 *
 * This adapter bridges the audit middleware (security/compliance layer) with
 * ACE's learning pipeline without duplicating data capture.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import type { RichContent, RichTrajectoryStep } from "@koi/core/rich-trajectory";

/** Configuration for the audit trajectory adapter. */
export interface AuditTrajectoryAdapterConfig {
  /** The audit sink to query for session entries. Must implement `query`. */
  readonly sink: AuditSink;
  /** Maximum characters per content field. Default: 2000. */
  readonly maxContentChars?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 2000;

/**
 * Create a rich trajectory source function from an audit sink.
 *
 * Returns a function suitable for `AceConfig.richTrajectorySource`.
 * The sink must implement the optional `query` method.
 */
export function createAuditTrajectoryAdapter(
  config: AuditTrajectoryAdapterConfig,
): (sessionId: string) => Promise<readonly RichTrajectoryStep[]> {
  const { sink } = config;

  if (sink.query === undefined) {
    throw new Error("Audit sink must implement query() to be used as a rich trajectory source");
  }

  const maxChars = config.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const queryFn: (sessionId: string) => Promise<readonly AuditEntry[]> = sink.query;

  return async (sessionId: string): Promise<readonly RichTrajectoryStep[]> => {
    const entries = await queryFn(sessionId);

    const result: RichTrajectoryStep[] = [];
    // let: mutable index for step numbering
    let stepIdx = 0;
    for (const entry of entries) {
      if (entry.kind === "model_call" || entry.kind === "tool_call") {
        result.push(
          mapAuditEntryToRichStep(
            entry as AuditEntry & { readonly kind: ActionKind },
            stepIdx,
            maxChars,
          ),
        );
        stepIdx++;
      }
    }
    return result;
  };
}

/** Audit entry kinds that map to trajectory steps. */
type ActionKind = "model_call" | "tool_call";

/** Map a single AuditEntry to a RichTrajectoryStep. */
export function mapAuditEntryToRichStep(
  entry: AuditEntry & { readonly kind: ActionKind },
  stepIndex: number,
  maxContentChars: number = DEFAULT_MAX_CONTENT_CHARS,
): RichTrajectoryStep {
  const kind: ActionKind = entry.kind;
  return {
    stepIndex,
    timestamp: entry.timestamp,
    source: kind === "model_call" ? "agent" : "tool",
    kind,
    identifier: extractIdentifier(entry),
    outcome: determineOutcome(entry),
    durationMs: entry.durationMs,
    ...(entry.request !== undefined
      ? { request: mapPayloadToContent(entry.request, maxContentChars) }
      : {}),
    ...(entry.response !== undefined
      ? { response: mapPayloadToContent(entry.response, maxContentChars) }
      : {}),
    ...(entry.error !== undefined
      ? { error: mapPayloadToContent(entry.error, maxContentChars) }
      : {}),
  };
}

function extractIdentifier(entry: AuditEntry): string {
  if (entry.request === undefined) return "unknown";

  // Try common field names for model/tool identification
  if (typeof entry.request === "object" && entry.request !== null) {
    const req = entry.request as Record<string, unknown>;
    if (typeof req.model === "string") return req.model;
    if (typeof req.toolId === "string") return req.toolId;
  }

  return "unknown";
}

function determineOutcome(entry: AuditEntry): "success" | "failure" | "retry" {
  if (entry.error !== undefined) return "failure";
  if (entry.response !== undefined) return "success";
  return "failure";
}

/** Convert an unknown audit payload into RichContent with truncation. */
export function mapPayloadToContent(payload: unknown, maxChars: number): RichContent {
  // Handle redacted payloads
  if (payload === "[redacted]") {
    return { text: "[redacted]" };
  }

  // Handle string payloads directly
  if (typeof payload === "string") {
    return truncateContent(payload, maxChars);
  }

  // Handle object payloads — serialize to JSON
  if (typeof payload === "object" && payload !== null) {
    try {
      const serialized = JSON.stringify(payload);
      return truncateContent(serialized, maxChars);
    } catch {
      return { text: "[unserializable]" };
    }
  }

  // Handle primitives
  return { text: String(payload) };
}

function truncateContent(text: string, maxChars: number): RichContent {
  if (text.length <= maxChars) {
    return { text };
  }
  return {
    text: `${text.slice(0, maxChars)}...`,
    truncated: true,
    originalSize: text.length,
  };
}
