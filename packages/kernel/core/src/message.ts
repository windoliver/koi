/**
 * Content block union and message types.
 */

import type { JsonObject } from "./common.js";

export interface TextBlock {
  readonly kind: "text";
  readonly text: string;
}

export interface FileBlock {
  readonly kind: "file";
  readonly url: string;
  readonly mimeType: string;
  readonly name?: string;
}

export interface ImageBlock {
  readonly kind: "image";
  readonly url: string;
  readonly alt?: string;
}

export interface ButtonBlock {
  readonly kind: "button";
  readonly label: string;
  readonly action: string;
  readonly payload?: unknown;
}

export interface CustomBlock {
  readonly kind: "custom";
  readonly type: string;
  readonly data: unknown;
}

export type ContentBlock = TextBlock | FileBlock | ImageBlock | ButtonBlock | CustomBlock;

export interface OutboundMessage {
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
}

export interface InboundMessage {
  readonly content: readonly ContentBlock[];
  readonly senderId: string;
  readonly threadId?: string;
  readonly timestamp: number;
  readonly metadata?: JsonObject;
  /** When true, compaction middleware must preserve this message verbatim. */
  readonly pinned?: boolean | undefined;
}

/**
 * A resumed-session message normalized for display in any host (TUI, CLI
 * stdout, log viewer). The filter rules live here so that every replay
 * surface — `koi start --resume`, `koi tui --resume`, the session picker,
 * `/rewind` replay — renders identical history. Adding a new filter (e.g.
 * dropping a new kind of metadata entry) updates both hosts in one place.
 */
export interface DisplayableResumedMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly ContentBlock[];
}

/**
 * Filter a replayed transcript down to the messages a human should see.
 *
 * Rules (shared by TUI and CLI — keep in sync with any replay surface):
 *   - `senderId === "tool"` entries are dropped (raw tool-result JSON)
 *   - Assistant entries with `metadata.toolCalls` set are dropped (the
 *     visible `content` is the tool-call UUID, not user-facing text)
 *   - `senderId.startsWith("system:")` entries are dropped (privileged
 *     engine-injected control/system text)
 *   - User entries with `metadata.resumedSystemRole === true` are dropped
 *     (plain `role: "system"` transcript entries rewritten by
 *     `resumeFromTranscript` to replay without privilege escalation —
 *     internal feedback, not user speech)
 *   - Any senderId other than "user" or "assistant" is dropped
 *
 * Content blocks are returned unchanged — callers are responsible for
 * rendering non-text blocks (image/file/button/custom) however fits
 * their UI. The TUI converts them to `[image]`-style placeholders;
 * `koi start` stdout does the same via its own mapper.
 */
export function filterResumedMessagesForDisplay(
  messages: readonly InboundMessage[],
): readonly DisplayableResumedMessage[] {
  const out: DisplayableResumedMessage[] = [];
  for (const msg of messages) {
    if (msg.senderId === "tool") continue;
    if (msg.senderId.startsWith("system:")) continue;
    if (msg.senderId === "user") {
      if (msg.metadata !== undefined && msg.metadata.resumedSystemRole === true) continue;
      out.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.senderId !== "assistant") continue;
    if (msg.metadata !== undefined && Array.isArray(msg.metadata.toolCalls)) continue;
    out.push({ role: "assistant", content: msg.content });
  }
  return out;
}
