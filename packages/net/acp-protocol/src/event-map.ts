/**
 * Bidirectional ACP ↔ Koi event mapping.
 *
 * - `mapSessionUpdate()`: ACP session/update → Koi EngineEvent (client side)
 * - `mapEngineEventToAcp()`: Koi EngineEvent → ACP session/update (server side)
 */

import type { EngineEvent } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { SessionUpdatePayload, TextContent } from "./acp-schema.js";

// ---------------------------------------------------------------------------
// ACP → Koi (used by engine-acp client)
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
        "[acp-protocol] Unknown session/update kind:",
        (_exhaustive as { sessionUpdate: string }).sessionUpdate,
      );
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Koi → ACP (used by acp server)
// ---------------------------------------------------------------------------

/**
 * Map a Koi EngineEvent to an ACP SessionUpdatePayload for session/update
 * notifications sent to the IDE.
 *
 * Returns `undefined` for events that have no ACP equivalent
 * (turn_start, turn_end, done) — the caller should skip those.
 *
 * - `text_delta` → `agent_message_chunk`
 * - `tool_call_start` → `tool_call` (status: "pending")
 * - `tool_call_delta` → `tool_call_update` (status: "in_progress")
 * - `tool_call_end` → `tool_call_update` (status: "completed" or "failed")
 * - `custom` with `acp:*` type → pass through as appropriate update kind
 * - `turn_start`, `turn_end`, `done` → undefined (no ACP equivalent)
 */
export function mapEngineEventToAcp(event: EngineEvent): SessionUpdatePayload | undefined {
  switch (event.kind) {
    case "text_delta":
      return {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: event.delta }],
      };

    case "tool_call_start":
      return {
        sessionUpdate: "tool_call",
        toolCallId: String(event.callId),
        title: event.toolName,
        kind: "other",
        status: "pending",
        ...(event.args !== undefined
          ? { rawInput: event.args as Readonly<Record<string, unknown>> }
          : {}),
      };

    case "tool_call_delta":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: String(event.callId),
        status: "in_progress",
        content: [{ type: "text", text: event.delta }],
      };

    case "tool_call_end": {
      const resultText =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: String(event.callId),
        status: "completed",
        content: [{ type: "text", text: resultText }],
      };
    }

    case "custom": {
      // Pass through acp:thought as agent_thought_chunk
      if (event.type === "acp:thought") {
        const data = event.data as { readonly text: string };
        return {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: data.text },
        };
      }
      // Pass through acp:plan as plan
      if (event.type === "acp:plan") {
        const data = event.data as { readonly text: string };
        return {
          sessionUpdate: "plan",
          content: [{ type: "text", text: data.text }],
        };
      }
      // Pass through acp:mode_change as current_mode_update
      if (event.type === "acp:mode_change") {
        const data = event.data as { readonly mode: string };
        return {
          sessionUpdate: "current_mode_update",
          mode: data.mode,
        };
      }
      // Non-ACP custom events → skip
      return undefined;
    }

    case "turn_start":
    case "turn_end":
    case "done":
    case "discovery:miss":
    case "spawn_requested":
    case "agent_spawned":
    case "agent_status_changed":
      // No ACP equivalent — handled at protocol level
      return undefined;

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return undefined;
    }
  }
}
