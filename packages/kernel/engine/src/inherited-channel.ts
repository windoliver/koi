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

  const child: Record<string, unknown> = {
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

  // Round-40 medium: forward adapter-specific extension methods that bypass
  // send() (e.g. MobileChannelAdapter.sendUnsolicited — the ONLY explicit
  // "deliver to currently connected socket" path on the mobile adapter).
  // Without this, child agents spawned onto a mobile parent channel lose
  // every proactive/live-delivery capability, silently downgrading to push
  // fallback or rejection. Listed explicitly so plain-looking methods on
  // the parent (`onMessage`, `connect`) cannot be re-typed and accidentally
  // forwarded — only documented outbound extensions get the bypass.
  const PARENT_EXTENSION_METHODS = ["sendUnsolicited"] as const;
  for (const methodName of PARENT_EXTENSION_METHODS) {
    const original = (parentChannel as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      const fn = original as (message: OutboundMessage) => Promise<void>;
      child[methodName] = (message: OutboundMessage): Promise<void> => {
        if (resolved.mode === "none") return Promise.resolve();
        return fn.call(parentChannel, attributeMessage(message));
      };
    }
  }
  return child as unknown as ChannelAdapter;
}
