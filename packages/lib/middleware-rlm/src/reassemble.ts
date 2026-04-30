/**
 * Pure reassembly: combine N segmented `ModelResponse`s into a single
 * response that downstream callers can treat as if the model had answered
 * the original (oversized) request once.
 *
 * The middleware concatenates per-segment text bodies; it does NOT
 * synthesize a globally aggregated answer. RLM is therefore only sound for
 * tasks whose answer is the in-order union of segment-local answers
 * (extraction, transformation, summarization-per-chunk). Tasks that
 * require global aggregation, deduplication, ranking, or cross-segment
 * reasoning must run an explicit reducer downstream — feeding the
 * reassembled output back through another model call — rather than
 * treating this output as final.
 */

import type { JsonObject, ModelContentBlock, ModelResponse, ModelStopReason } from "@koi/core";

/**
 * Legacy named export — historic callers relied on the constant. The default
 * separator is now empty (byte-faithful concat); set
 * `RlmConfig.segmentSeparator` if a delimiter is needed.
 */
export const SEGMENT_SEPARATOR = "";

/** Stop reasons that signal an incomplete response we must NOT silently merge. */
const ABORTING_STOP_REASONS: ReadonlySet<ModelStopReason> = new Set<ModelStopReason>([
  "length",
  "tool_use",
  "error",
  "hook_blocked",
]);

/**
 * Per-segment provenance carried through `metadata.rlmSegments` so callers
 * can audit which model answered each chunk, the per-segment responseId,
 * and the per-segment stopReason. None of this would be reachable through
 * the merged top-level fields.
 */
interface SegmentProvenance extends JsonObject {
  readonly index: number;
  readonly model: string;
  readonly stopReason?: string | undefined;
  readonly responseId?: string | undefined;
}

interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

function sumUsage(parts: readonly ModelResponse[]): UsageTotals | undefined {
  let any = false; // let: presence flag while folding
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  for (const part of parts) {
    if (part.usage === undefined) continue;
    any = true;
    inputTokens += part.usage.inputTokens;
    outputTokens += part.usage.outputTokens;
    if (part.usage.cacheReadTokens !== undefined) {
      cacheReadTokens += part.usage.cacheReadTokens;
      hasCacheRead = true;
    }
    if (part.usage.cacheWriteTokens !== undefined) {
      cacheWriteTokens += part.usage.cacheWriteTokens;
      hasCacheWrite = true;
    }
  }
  if (!any) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
  };
}

/**
 * Reconstruct merged `richContent` across segments without losing the text
 * carried in plain `content` for segments that did not return richContent.
 *
 * The engine's synthesized `modelStream` path replays `richContent` and
 * ignores `content` when `richContent` is present, so a partial richContent
 * would silently drop text from the stream view of an otherwise complete
 * answer. We rebuild the full ordered representation:
 *
 *   - For each segment, push the segment's own `richContent` blocks if
 *     present, otherwise synthesize a single text block from its `content`
 *     (no-op when both are empty).
 *   - Insert a `\n\n` text separator between segments to mirror the
 *     `content` field's join semantics.
 *
 * Returns `undefined` when no segment carries `richContent` — the merged
 * response keeps `content` only and the stream path falls back to it.
 */
/**
 * Convert a single segment to its richContent representation, preserving
 * the segment's text whenever it would otherwise be dropped by the stream
 * path. The engine's synthesized `modelStream` replays `richContent`
 * verbatim and ignores `content` when richContent is set, so a segment
 * with non-empty `content` plus a non-text `richContent` (thinking-only,
 * tool-call-only, etc.) would silently lose its text on the stream view.
 *
 * Rules:
 *   - If richContent already carries a text block, trust the adapter and
 *     return richContent verbatim.
 *   - If richContent has no text block but `content` does, prepend a
 *     synthesized text block so the merged stream view stays complete.
 *   - If neither carries text, return what we have (possibly empty).
 */
function segmentBlocks(part: ModelResponse): readonly ModelContentBlock[] {
  const rich = part.richContent;
  if (rich !== undefined && rich.length > 0) {
    const richHasText = rich.some((b) => b.kind === "text");
    if (richHasText) return rich;
    if (part.content.length > 0) {
      return [{ kind: "text", text: part.content }, ...rich];
    }
    return rich;
  }
  if (part.content.length > 0) return [{ kind: "text", text: part.content }];
  return [];
}

function buildMergedRichContent(
  parts: readonly ModelResponse[],
  separator: string,
): readonly ModelContentBlock[] | undefined {
  let anyRich = false; // let: presence flag for richContent across parts
  for (const p of parts) {
    if (p.richContent !== undefined && p.richContent.length > 0) {
      anyRich = true;
      break;
    }
  }
  if (!anyRich) return undefined;

  const blocks: ModelContentBlock[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && separator.length > 0) {
      blocks.push({ kind: "text", text: separator });
    }
    const part = parts[i];
    if (part === undefined) continue;
    for (const block of segmentBlocks(part)) blocks.push(block);
  }
  return blocks;
}

function buildProvenance(parts: readonly ModelResponse[]): readonly SegmentProvenance[] {
  return parts.map((p, i) => ({
    index: i,
    model: p.model,
    ...(p.stopReason !== undefined ? { stopReason: p.stopReason } : {}),
    ...(p.responseId !== undefined ? { responseId: p.responseId } : {}),
  }));
}

function pickStopReason(parts: readonly ModelResponse[]): ModelStopReason | undefined {
  // Surface the strongest non-success signal so callers see truncation or
  // a flagged segment rather than the last-segment "stop" masking it.
  for (const p of parts) {
    if (p.stopReason !== undefined && ABORTING_STOP_REASONS.has(p.stopReason)) {
      return p.stopReason;
    }
  }
  const last = parts[parts.length - 1];
  return last?.stopReason;
}

/**
 * Concatenate segmented responses in order. Use of this function commits
 * the caller to the "segment-local task" contract — see file header.
 *
 * Top-level fields:
 *   - `content` — segment bodies joined by `SEGMENT_SEPARATOR`
 *   - `model` / `responseId` — taken from the first segment for backward
 *     compatibility; per-segment values preserved in `metadata.rlmSegments`
 *   - `stopReason` — the strongest non-success reason across segments, or
 *     the last segment's reason when all completed normally
 *   - `usage` — summed across segments (cache fields aggregated when present)
 *   - `richContent` — concatenated in segment order
 *   - `metadata.rlmSegments` — array of `{ index, model, stopReason, responseId }`
 *     for every segment, so callers can audit per-segment routing/safety
 *
 * @param parts segmented responses to combine; must be non-empty
 * @param separator string inserted between segment bodies. Defaults to
 *   `""` for byte-faithful concatenation; pass `"\n\n"` (or other) for
 *   summarization-style outputs that benefit from readable boundaries.
 *
 * @throws if `parts` is empty.
 */
export function reassembleResponses(
  parts: readonly ModelResponse[],
  separator = "",
): ModelResponse {
  if (parts.length === 0) {
    throw new Error("reassembleResponses requires at least one response");
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("reassembleResponses received holes in the parts array");
  }
  if (parts.length === 1) return first;

  const content = parts.map((p) => p.content).join(separator);
  const usage = sumUsage(parts);
  const richContent = buildMergedRichContent(parts, separator);
  const stopReason = pickStopReason(parts);
  const provenance = buildProvenance(parts);
  // Detect mixed-provider results. When per-segment routing or fallback
  // sends segments to different models / responseIds, copying first-only
  // identity into the top-level fields would silently misattribute
  // aggregated usage to a single backend. Cost dashboards, traces, and
  // incident debugging all key off `model` / `responseId` and would
  // believe the lie. Surface the mix as a synthetic `koi:rlm-mixed`
  // marker so observability sees the truth; per-segment provenance
  // remains in `metadata.rlmSegments` for callers that care.
  const allSameModel = parts.every((p) => p.model === first.model);
  const mergedModel = allSameModel ? first.model : "koi:rlm-mixed";
  const allSameResponseId = parts.every((p) => p.responseId === first.responseId);
  const mergedResponseId =
    first.responseId !== undefined && allSameResponseId ? first.responseId : undefined;
  // Merge metadata across every segment with last-write-wins per key.
  // Later-segment signals like `terminatedBy`, `blockedByHook`, recovery
  // metadata, and routing decisions must survive the merge so downstream
  // delivery / query / observability paths see them. Hard-coding
  // first.metadata would silently lose those signals when only later
  // segments carry them. rlmSegments still reflects full provenance.
  const mergedMetadata: JsonObject = {};
  for (const p of parts) {
    if (p.metadata === undefined) continue;
    Object.assign(mergedMetadata, p.metadata);
  }
  const metadata: JsonObject = { ...mergedMetadata, rlmSegments: provenance };

  const out: ModelResponse = {
    content,
    model: mergedModel,
    ...(usage !== undefined ? { usage } : {}),
    metadata,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(mergedResponseId !== undefined ? { responseId: mergedResponseId } : {}),
    ...(richContent !== undefined ? { richContent } : {}),
  };
  return out;
}
