/**
 * Generic content block walker for platform send implementations.
 *
 * Handles the common accumulate-text → flush-on-non-text pattern that all
 * platform-send functions share. Adapters provide platform-specific callbacks
 * for each block kind; walkContentBlocks handles text merging and flushing.
 *
 * Text blocks are accumulated and merged with newlines. When a non-text block
 * arrives, accumulated text is flushed via onText() before the non-text
 * callback is invoked. Remaining text is flushed after the last block.
 */

import type { ButtonBlock, ContentBlock, CustomBlock, FileBlock, ImageBlock } from "@koi/core";

/** Callbacks for each content block kind. All are optional — missing callbacks skip the block. */
export interface WalkCallbacks {
  /** Called with merged text when flushed (on non-text block or end of blocks). */
  readonly onText?: (text: string) => void;
  /** Called for each image block (after flushing any pending text). */
  readonly onImage?: (block: ImageBlock) => void;
  /** Called for each file block (after flushing any pending text). */
  readonly onFile?: (block: FileBlock) => void;
  /** Called for each button block (after flushing any pending text). */
  readonly onButton?: (block: ButtonBlock) => void;
  /** Called for each custom block (after flushing any pending text). */
  readonly onCustom?: (block: CustomBlock) => void;
}

/**
 * Walks an array of content blocks, accumulating adjacent text blocks and
 * flushing them when a non-text block is encountered or at the end.
 *
 * @param blocks - The content blocks to walk.
 * @param callbacks - Platform-specific handlers for each block kind.
 */
export function walkContentBlocks(blocks: readonly ContentBlock[], callbacks: WalkCallbacks): void {
  // let requires justification: accumulates adjacent text blocks before flush
  let pendingText = "";

  const flush = (): void => {
    if (pendingText.length > 0 && callbacks.onText !== undefined) {
      callbacks.onText(pendingText);
    }
    pendingText = "";
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        pendingText = pendingText.length > 0 ? `${pendingText}\n${block.text}` : block.text;
        break;
      case "image":
        flush();
        callbacks.onImage?.(block);
        break;
      case "file":
        flush();
        callbacks.onFile?.(block);
        break;
      case "button":
        flush();
        callbacks.onButton?.(block);
        break;
      case "custom":
        flush();
        callbacks.onCustom?.(block);
        break;
    }
  }

  // Flush remaining text after the last block
  flush();
}
