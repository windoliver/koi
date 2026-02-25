/**
 * ContentBlock → AG-UI event mapper.
 *
 * Maps Koi OutboundMessage ContentBlocks to a sequence of AG-UI BaseEvents:
 *
 *   TextBlock   → TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT + TEXT_MESSAGE_END
 *   ImageBlock  → CUSTOM (type: "koi:image")
 *   FileBlock   → CUSTOM (type: "koi:file")
 *   ButtonBlock → CUSTOM (type: "koi:button")
 *   CustomBlock → CUSTOM (type: block.type, data: block.data)
 *
 * Non-text blocks are emitted as CUSTOM events so CopilotKit frontends can
 * render them with custom components. The exhaustive switch ensures new
 * ContentBlock variants are caught at compile time.
 */

import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { ContentBlock } from "@koi/core";

/**
 * Convert a ContentBlock array into an ordered sequence of AG-UI events.
 *
 * @param blocks  - The OutboundMessage content blocks to convert.
 * @param messageId - A stable identifier for the message being streamed.
 *                    Should be unique per outbound message.
 */
export function mapBlocksToAguiEvents(
  blocks: readonly ContentBlock[],
  messageId: string,
): readonly BaseEvent[] {
  const events: BaseEvent[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "text": {
        events.push(
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } satisfies BaseEvent,
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: block.text,
          } satisfies BaseEvent,
          { type: EventType.TEXT_MESSAGE_END, messageId } satisfies BaseEvent,
        );
        break;
      }
      case "image": {
        events.push({
          type: EventType.CUSTOM,
          name: "koi:image",
          value: { url: block.url, alt: block.alt },
        } satisfies BaseEvent);
        break;
      }
      case "file": {
        events.push({
          type: EventType.CUSTOM,
          name: "koi:file",
          value: { url: block.url, mimeType: block.mimeType, name: block.name },
        } satisfies BaseEvent);
        break;
      }
      case "button": {
        events.push({
          type: EventType.CUSTOM,
          name: "koi:button",
          value: { label: block.label, action: block.action, payload: block.payload },
        } satisfies BaseEvent);
        break;
      }
      case "custom": {
        events.push({
          type: EventType.CUSTOM,
          name: block.type,
          value: block.data,
        } satisfies BaseEvent);
        break;
      }
    }
  }

  return events;
}
