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
