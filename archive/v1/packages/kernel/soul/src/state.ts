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
  /** Pre-computed meta-instruction text for self-modification awareness. Empty when disabled. */
  readonly metaInstructionText: string;
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

/** Sources grouped by layer for meta-instruction generation. */
export interface MetaInstructionSources {
  /** Resolved soul file paths (global personality). */
  readonly soul: readonly string[];
  /** Resolved identity file paths (per-channel persona). */
  readonly identity: readonly string[];
  /** Resolved user file paths (user context). */
  readonly user: readonly string[];
}

/** Filters out "inline" entries, returning only real file paths. */
function filePaths(sources: readonly string[]): readonly string[] {
  return sources.filter((s) => s !== "inline");
}

/**
 * Generates the meta-instruction text that teaches the agent about self-modification.
 *
 * Returns empty string when:
 * - `selfModify` is false
 * - No resolvable file sources exist (all inline or empty)
 */
export function generateMetaInstructionText(
  sources: MetaInstructionSources,
  selfModify: boolean,
): string {
  if (!selfModify) return "";

  const soulFiles = filePaths(sources.soul);
  const identityFiles = filePaths(sources.identity);
  const userFiles = filePaths(sources.user);

  const allFiles = [...soulFiles, ...identityFiles, ...userFiles];
  if (allFiles.length === 0) return "";

  const lines: string[] = ["[Soul System]"];

  // Single file — compact format
  if (allFiles.length === 1 && soulFiles.length === 1) {
    lines.push(`Your personality is defined in ${soulFiles[0]}.`);
  } else {
    // Multi-file — grouped listing
    lines.push("Your personality is defined in these files:");
    for (const f of soulFiles) {
      lines.push(`- ${f} (global personality) — core behavior, tone, values`);
    }
    for (const f of identityFiles) {
      lines.push(`- ${f} (channel persona) — channel-specific style and rules`);
    }
    for (const f of userFiles) {
      lines.push(`- ${f} (user context) — user preferences and context`);
    }
  }

  lines.push(
    "You may propose changes by writing to these files.",
    "Changes require human approval and take effect on your next response.",
    "",
    "When to update:",
    "- When the user gives persistent feedback about your behavior",
    "- When you learn a pattern that should be permanent",
    "- When the user explicitly asks you to remember something about yourself",
    "",
    "Do NOT update for:",
    "- One-time task preferences",
    "- Transient conversation context",
    "- Information that belongs in memory, not personality",
  );

  return lines.join("\n");
}

/**
 * Concatenates non-empty soul, identity, user, and meta-instruction layers
 * into a single InboundMessage for system prompt injection.
 *
 * Returns undefined when all layers are empty.
 */
export function createSoulMessage(
  soulText: string,
  identityText: string | undefined,
  userText: string,
  metaInstructionText: string = "",
): InboundMessage | undefined {
  const parts = [
    soulText.length > 0 ? soulText : undefined,
    identityText !== undefined && identityText.length > 0 ? identityText : undefined,
    userText.length > 0 ? userText : undefined,
    metaInstructionText.length > 0 ? metaInstructionText : undefined,
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
