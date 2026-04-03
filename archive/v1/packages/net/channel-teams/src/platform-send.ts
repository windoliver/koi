/**
 * Sends OutboundMessage to Teams conversations.
 */

import { splitText } from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";

/** Maximum text length per Teams message (OpenClaw uses 4000). */
const TEAMS_TEXT_LIMIT = 4000;

/** Minimal turn context interface for sending activities. */
export interface TeamsTurnContext {
  readonly sendActivity: (
    activity:
      | string
      | {
          readonly type: string;
          readonly text?: string;
          readonly attachments?: readonly unknown[];
        },
  ) => Promise<unknown>;
}

/** Stores turn contexts by conversation ID for later sending. */
export interface TurnContextStore {
  readonly get: (conversationId: string) => TeamsTurnContext | undefined;
  readonly set: (conversationId: string, context: TeamsTurnContext) => void;
}

/**
 * Creates a platform send function that serializes OutboundMessage
 * to Teams Activity responses.
 */
export function createPlatformSend(
  contextStore: TurnContextStore,
): (message: OutboundMessage) => Promise<void> {
  return async (message: OutboundMessage): Promise<void> => {
    const conversationId = message.threadId;
    if (conversationId === undefined) {
      throw new Error(
        "[channel-teams] Cannot send: threadId is required. Echo threadId from InboundMessage.",
      );
    }

    const turnContext = contextStore.get(conversationId);
    if (turnContext === undefined) {
      // No active turn context — skip (proactive messaging not yet supported)
      return;
    }

    // Merge text blocks into a single message
    const textParts: string[] = [];
    for (const block of message.content) {
      switch (block.kind) {
        case "text": {
          textParts.push(block.text);
          break;
        }
        case "image": {
          textParts.push(`![${block.alt ?? "image"}](${block.url})`);
          break;
        }
        case "file": {
          textParts.push(`[${block.name ?? "file"}](${block.url})`);
          break;
        }
        case "button": {
          textParts.push(`[${block.label}]`);
          break;
        }
        case "custom": {
          // Skip custom blocks
          break;
        }
      }
    }

    if (textParts.length === 0) {
      return;
    }

    const body = textParts.join("\n");
    const chunks = splitText(body, TEAMS_TEXT_LIMIT);

    for (const chunk of chunks) {
      await turnContext.sendActivity({
        type: "message",
        text: chunk,
      });
    }
  };
}
