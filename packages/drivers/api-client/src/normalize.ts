/**
 * Normalize Koi InboundMessage[] into Anthropic SDK message format.
 *
 * Responsibilities:
 * - Map senderId to Anthropic role (user/assistant/system)
 * - Extract system messages into a separate string
 * - Convert ContentBlock[] to Anthropic content parts
 * - Merge consecutive same-role messages (Anthropic API requirement)
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, InboundMessage } from "@koi/core";

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

/** Map a Koi senderId to an Anthropic-compatible role. */
export function mapSenderIdToRole(senderId: string): "user" | "assistant" | "system" {
  if (senderId === "assistant") return "assistant";
  if (senderId === "system" || senderId.startsWith("system:")) return "system";
  return "user";
}

/** Parse a data URL into base64 components. */
function parseDataUrl(
  url: string,
): { readonly data: string; readonly mediaType: string } | undefined {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { mediaType: match[1], data: match[2] };
  }
  return undefined;
}

/** Convert a single Koi ContentBlock to an Anthropic content part. */
function contentBlockToAnthropicPart(block: ContentBlock): ContentBlockParam {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "image": {
      const parsed = parseDataUrl(block.url);
      if (parsed !== undefined) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType as Anthropic.Base64ImageSource["media_type"],
            data: parsed.data,
          },
        };
      }
      return { type: "image", source: { type: "url", url: block.url } };
    }
    default:
      // file, button, custom → text fallback
      return { type: "text", text: contentBlockToPlainText(block) };
  }
}

/** Plain text fallback for non-text/image content blocks. */
function contentBlockToPlainText(block: ContentBlock): string {
  switch (block.kind) {
    case "text":
      return block.text;
    case "file":
      return `[file: ${block.name ?? block.url}]`;
    case "image":
      return `[image: ${block.alt ?? block.url}]`;
    case "button":
      return `[button: ${block.label}]`;
    case "custom":
      return `[${block.type}]`;
  }
}

/** Convert Koi ContentBlock[] to Anthropic content format. */
export function toAnthropicContent(content: readonly ContentBlock[]): string | ContentBlockParam[] {
  const hasRichContent = content.some((b) => b.kind === "image");
  if (!hasRichContent) {
    return content.map(contentBlockToPlainText).join("");
  }
  return content.map(contentBlockToAnthropicPart);
}

/** Result of extracting system messages from the conversation. */
export interface ExtractedMessages {
  readonly system: string | undefined;
  readonly messages: readonly MessageParam[];
}

/**
 * Extract system messages and produce Anthropic-compatible message params.
 *
 * - System-role messages are extracted into a single `system` string
 * - Remaining messages are role-mapped and consecutive same-role messages are merged
 */
export function extractSystemAndMessages(messages: readonly InboundMessage[]): ExtractedMessages {
  const systemTexts: string[] = [];
  const anthropicMessages: MessageParam[] = [];

  for (const msg of messages) {
    const role = mapSenderIdToRole(msg.senderId);

    if (role === "system") {
      systemTexts.push(msg.content.map(contentBlockToPlainText).join(""));
      continue;
    }

    const content = toAnthropicContent(msg.content);
    const last = anthropicMessages[anthropicMessages.length - 1];

    // Merge consecutive same-role messages (Anthropic API requirement)
    if (last !== undefined && last.role === role) {
      const merged = mergeContent(last.content, content);
      anthropicMessages[anthropicMessages.length - 1] = { role, content: merged } as MessageParam;
    } else {
      anthropicMessages.push({ role, content } as MessageParam);
    }
  }

  return {
    system: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

/** Merge two Anthropic content values into one. */
function mergeContent(
  a: string | ContentBlockParam[],
  b: string | ContentBlockParam[],
): string | ContentBlockParam[] {
  if (typeof a === "string" && typeof b === "string") {
    return `${a}\n${b}`;
  }
  const aParts: ContentBlockParam[] = typeof a === "string" ? [{ type: "text", text: a }] : a;
  const bParts: ContentBlockParam[] = typeof b === "string" ? [{ type: "text", text: b }] : b;
  return [...aParts, ...bParts];
}
