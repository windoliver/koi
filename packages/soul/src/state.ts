/**
 * Atomic SoulState — all mutable closure state consolidated into one object
 * for clean atomic swaps during reload.
 */

import type { InboundMessage } from "@koi/core/message";
import type { CachedPersona } from "./persona-map.js";

/** Consolidated soul middleware state. */
export interface SoulState {
  readonly soulText: string;
  readonly soulSources: readonly string[];
  readonly personaMap: ReadonlyMap<string, CachedPersona>;
  readonly userText: string;
  readonly userSources: readonly string[];
  readonly watchedPaths: ReadonlySet<string>;
}

/**
 * Creates the set of all file paths watched for auto-reload.
 * Excludes "inline" sources (no file to watch).
 */
export function createAllWatchedPaths(
  soulSources: readonly string[],
  personaMap: ReadonlyMap<string, CachedPersona>,
  userSources: readonly string[],
): Set<string> {
  return new Set([
    ...soulSources.filter((s) => s !== "inline"),
    ...Array.from(personaMap.values()).flatMap((cached) => [...cached.sources]),
    ...userSources.filter((s) => s !== "inline"),
  ]);
}

/** Default total token cap for the combined system message. */
const DEFAULT_TOTAL_MAX_CHARS = 8000 * 4; // 8000 tokens * 4 chars/token

/**
 * Concatenates non-empty soul, identity, and user layers into a single
 * InboundMessage for system prompt injection.
 *
 * Returns undefined when all layers are empty.
 */
export function createSoulMessage(
  soulText: string,
  identityText: string | undefined,
  userText: string,
): InboundMessage | undefined {
  const parts = [
    soulText.length > 0 ? soulText : undefined,
    identityText !== undefined && identityText.length > 0 ? identityText : undefined,
    userText.length > 0 ? userText : undefined,
  ].filter((p): p is string => p !== undefined);

  if (parts.length === 0) return undefined;

  let text = parts.join("\n\n"); // let: conditionally truncated below

  // Apply total token cap
  if (text.length > DEFAULT_TOTAL_MAX_CHARS) {
    text = text.slice(0, DEFAULT_TOTAL_MAX_CHARS);
  }

  return {
    senderId: "system:soul",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}
