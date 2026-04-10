/**
 * Mock InboundMessage factory.
 *
 * `text` is a convenience for the common case: it becomes a single
 * text ContentBlock. Explicit `content` wins over `text`.
 */

import type { InboundMessage } from "@koi/core";

export function createMockInboundMessage(
  overrides?: Partial<InboundMessage> & { readonly text?: string },
): InboundMessage {
  const text = overrides?.text;
  const content = overrides?.content ?? (text !== undefined ? [{ kind: "text", text }] : []);

  const base: InboundMessage = {
    content,
    senderId: "test-user",
    timestamp: 0,
  };

  if (overrides === undefined) {
    return base;
  }

  const { text: _ignoreText, content: _ignoreContent, ...rest } = overrides;
  return { ...base, ...rest, content };
}
