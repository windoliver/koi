/**
 * ContentBlock factory utilities — typed builders for each block kind.
 *
 * Use these in MessageNormalizer<E> implementations to build InboundMessage
 * content blocks from platform-specific event data.
 */

import type {
  ButtonBlock,
  ContentBlock,
  CustomBlock,
  FileBlock,
  ImageBlock,
  TextBlock,
} from "@koi/core";

export function text(content: string): TextBlock {
  return { kind: "text", text: content };
}

export function file(url: string, mimeType: string, name?: string): FileBlock {
  // Conditional inclusion required by exactOptionalPropertyTypes — name: undefined is not assignable to name?: string
  if (name !== undefined) {
    return { kind: "file", url, mimeType, name };
  }
  return { kind: "file", url, mimeType };
}

export function image(url: string, alt?: string): ImageBlock {
  // Conditional inclusion required by exactOptionalPropertyTypes
  if (alt !== undefined) {
    return { kind: "image", url, alt };
  }
  return { kind: "image", url };
}

export function button(label: string, action: string, payload?: unknown): ButtonBlock {
  // Conditional inclusion required by exactOptionalPropertyTypes
  if (payload !== undefined) {
    return { kind: "button", label, action, payload };
  }
  return { kind: "button", label, action };
}

export function custom(type: string, data: unknown): CustomBlock {
  return { kind: "custom", type, data };
}

/** Re-export the union type so callers don't need to import @koi/core directly. */
export type { ContentBlock };
