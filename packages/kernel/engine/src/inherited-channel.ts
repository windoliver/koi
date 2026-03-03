/**
 * Inherited channel proxy — delegates send() to parent channel with child attribution.
 *
 * Follows SpawnChannelPolicy for mode, attribution, and status propagation.
 * connect()/disconnect() are no-ops — parent owns channel lifecycle.
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ContentBlock,
  MessageHandler,
  OutboundMessage,
  ProcessId,
  SpawnChannelPolicy,
} from "@koi/core";
import { DEFAULT_SPAWN_CHANNEL_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInheritedChannel(
  parentChannel: ChannelAdapter,
  childPid: ProcessId,
  policy?: SpawnChannelPolicy,
): ChannelAdapter {
  const resolved = policy ?? DEFAULT_SPAWN_CHANNEL_POLICY;
  const attribution = resolved.attribution ?? "metadata";

  function attributeMessage(message: OutboundMessage): OutboundMessage {
    if (attribution === "none") return message;

    if (attribution === "metadata") {
      return {
        ...message,
        metadata: {
          ...message.metadata,
          sender: childPid.id,
          senderName: childPid.name,
        },
      };
    }

    // attribution === "prefix" — prepend child name to text blocks
    return {
      ...message,
      content: message.content.map((block: ContentBlock) =>
        block.kind === "text" ? { ...block, text: `[${childPid.name}] ${block.text}` } : block,
      ),
    };
  }

  const capabilities: ChannelCapabilities = { ...parentChannel.capabilities };

  return {
    name: `inherited:${childPid.name}`,
    capabilities,

    // No-ops — parent owns lifecycle
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},

    send: async (message: OutboundMessage): Promise<void> => {
      if (resolved.mode === "none") return;
      await parentChannel.send(attributeMessage(message));
    },

    onMessage: (handler: MessageHandler): (() => void) => {
      if (resolved.mode !== "all") {
        // output-only or none: child does not receive inbound messages
        return () => {};
      }
      return parentChannel.onMessage(handler);
    },

    sendStatus: async (status: ChannelStatus): Promise<void> => {
      if (!resolved.propagateStatus) return;
      if (parentChannel.sendStatus === undefined) return;
      await parentChannel.sendStatus({
        ...status,
        metadata: {
          ...status.metadata,
          sender: childPid.id,
          senderName: childPid.name,
        },
      });
    },
  };
}
