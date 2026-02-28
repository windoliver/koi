/**
 * ACP session/update notification → Koi EngineEvent mapping.
 *
 * Maps each ACP update kind to the appropriate Koi EngineEvent
 * discriminated union variant.
 */

import type { EngineEvent } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { SessionUpdatePayload, TextContent } from "./acp-schema.js";

// ---------------------------------------------------------------------------
// Map ACP session/update payload to Koi EngineEvents
// ---------------------------------------------------------------------------

/**
 * Map an ACP session/update payload to zero or more Koi EngineEvents.
 *
 * - `agent_message_chunk` → `text_delta` for each text content block
 * - `agent_thought_chunk` → `custom(thought)` event
 * - `tool_call` → `tool_call_start`
 * - `tool_call_update` with status `completed`/`failed` → `tool_call_end`
 * - `tool_call_update` with other status → `tool_call_delta`
 * - `plan` → `custom(plan)` event
 * - `current_mode_update` → `custom(mode_change)` event
 */
export function mapSessionUpdate(update: SessionUpdatePayload): readonly EngineEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const events: EngineEvent[] = [];
      for (const block of update.content) {
        if (block.type === "text") {
          const textBlock = block as TextContent;
          if (textBlock.text.length > 0) {
            events.push({ kind: "text_delta", delta: textBlock.text });
          }
        }
        // Image/resource blocks emitted as custom events for UI layers
        if (block.type === "image") {
          events.push({
            kind: "custom",
            type: "acp:image_block",
            data: { mimeType: block.mimeType, data: block.data },
          });
        }
      }
      return events;
    }

    case "agent_thought_chunk": {
      return [
        {
          kind: "custom",
          type: "acp:thought",
          data: { text: update.content.text },
        },
      ];
    }

    case "tool_call": {
      return [
        {
          kind: "tool_call_start",
          toolName: update.title,
          callId: toolCallId(update.toolCallId),
          ...(update.rawInput !== undefined ? { args: update.rawInput } : {}),
        },
      ];
    }

    case "tool_call_update": {
      const cid = toolCallId(update.toolCallId);
      if (update.status === "completed" || update.status === "failed") {
        const resultText =
          update.content
            ?.filter((b): b is TextContent => b.type === "text")
            .map((b) => b.text)
            .join("") ?? "";
        return [
          {
            kind: "tool_call_end",
            callId: cid,
            result: resultText,
          },
        ];
      }
      // in_progress or pending — emit as delta with status in data
      return [
        {
          kind: "custom",
          type: "acp:tool_call_update",
          data: { toolCallId: update.toolCallId, status: update.status },
        },
      ];
    }

    case "plan": {
      const planText = update.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("");
      return [
        {
          kind: "custom",
          type: "acp:plan",
          data: { text: planText },
        },
      ];
    }

    case "current_mode_update": {
      return [
        {
          kind: "custom",
          type: "acp:mode_change",
          data: { mode: update.mode },
        },
      ];
    }

    default: {
      // Exhaustive check for unknown future update kinds
      const _exhaustive: never = update;
      console.warn(
        "[engine-acp] Unknown session/update kind:",
        (_exhaustive as { sessionUpdate: string }).sessionUpdate,
      );
      return [];
    }
  }
}
