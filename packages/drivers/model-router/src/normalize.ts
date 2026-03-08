/**
 * Shared message normalization utilities for provider adapters.
 */

import type { ContentBlock, InboundMessage, TextBlock } from "@koi/core";

/**
 * Extracts plain text from a content block array by filtering for text blocks
 * and joining their text. Used by all provider adapters that accept text-only input.
 */
export function normalizeToPlainText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Canonical role type for normalized messages.
 * Maps to the common subset understood by all LLM providers.
 */
export type NormalizedRole = "user" | "assistant" | "system";

/**
 * A provider-agnostic normalized message preserving role and rich content.
 */
export interface NormalizedMessage {
  readonly role: NormalizedRole;
  readonly content: readonly ContentBlock[];
}

/**
 * Derives a canonical role from an InboundMessage's senderId.
 *
 * - "assistant" → "assistant"
 * - "system" or "system:*" → "system"
 * - everything else (user, tool, channel-specific IDs) → "user"
 */
export function mapSenderIdToRole(senderId: string): NormalizedRole {
  if (senderId === "assistant") return "assistant";
  if (senderId === "system" || senderId.startsWith("system:")) return "system";
  return "user";
}

/**
 * Normalizes InboundMessages preserving original roles and rich content blocks.
 * Unlike `normalizeToPlainText`, this retains image/file blocks and multi-turn
 * role information for adapters that support structured content.
 */
export function normalizeMessages(
  messages: readonly InboundMessage[],
): readonly NormalizedMessage[] {
  return messages.map((m) => ({
    role: mapSenderIdToRole(m.senderId),
    content: m.content,
  }));
}
