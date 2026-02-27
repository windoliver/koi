/**
 * Runtime detection of A2UI content blocks without importing @koi/canvas.
 *
 * Uses structural narrowing on CustomBlock.data to identify A2UI messages
 * and extract their metadata. This avoids an L2-to-L2 import violation.
 */

import type { ContentBlock } from "@koi/core";

/** A2UI event type prefix used in CustomBlock.type. */
const A2UI_PREFIX = "a2ui:";

/** Known A2UI message kinds. */
const A2UI_KINDS: ReadonlySet<string> = new Set([
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
]);

/** Extracted metadata from an A2UI content block. */
export interface A2uiBlockInfo {
  readonly kind: string;
  readonly surfaceId: string;
  readonly title?: string;
  readonly rawData: unknown;
}

/** Returns true if the content block is an A2UI custom block. */
export function isA2uiBlock(block: ContentBlock): boolean {
  return block.kind === "custom" && block.type.startsWith(A2UI_PREFIX);
}

/**
 * Extracts A2UI metadata from a content block via runtime narrowing.
 * Returns undefined if the block is not a valid A2UI block.
 */
export function extractA2uiBlockInfo(block: ContentBlock): A2uiBlockInfo | undefined {
  if (!isA2uiBlock(block)) return undefined;

  if (block.kind !== "custom") return undefined;
  const data: unknown = block.data;
  if (typeof data !== "object" || data === null) return undefined;

  const record = data as Readonly<Record<string, unknown>>;
  const kind = record.kind;
  if (typeof kind !== "string" || !A2UI_KINDS.has(kind)) return undefined;

  const surfaceId = record.surfaceId;
  if (typeof surfaceId !== "string") return undefined;

  const base = { kind, surfaceId, rawData: data };
  const title = record.title;
  return typeof title === "string" ? { ...base, title } : base;
}
