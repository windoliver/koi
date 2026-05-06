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

  // Round-40 medium / Round-53 high: forward PRIVILEGED OUTBOUND
  // extensions (sendUnsolicited — the explicit escape hatch that targets
  // the currently connected socket OR an explicit offline recipient via
  // opts.recipient). Stronger than the normal reply-correlation path:
  // round-53 review correctly flagged that an output-only child must NOT
  // be able to initiate proactive delivery on its own. Required:
  // `mode === "all"` (full bidirectional channel access). Output-only
  // and none are both blocked. When admitted, attribution still applies.
  const PARENT_PRIVILEGED_OUTBOUND_EXTENSIONS = ["sendUnsolicited"] as const;
  for (const methodName of PARENT_PRIVILEGED_OUTBOUND_EXTENSIONS) {
    const original = (parentChannel as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      // Round-42 high: forward the full extension signature, not just the
      // first arg. `MobileChannelAdapter.sendUnsolicited(message, {recipient})`
      // uses the second argument to safely route mismatched-live or offline
      // sends through pushNotifier — dropping it silently breaks explicit
      // recipient targeting through composed/proxied paths.
      const fn = original as (message: OutboundMessage, ...rest: unknown[]) => Promise<void>;
      child[methodName] = (message: OutboundMessage, ...rest: unknown[]): Promise<void> => {
        if (resolved.mode !== "all") return Promise.resolve();
        return fn.call(parentChannel, attributeMessage(message), ...rest);
      };
    }
  }

  // Round-44 high: forward adapter-specific READ-ONLY helpers that do not
  // go through send() and need no attribution — `VoiceChannelAdapter`'s
  // `stampForCurrentCall(outbound)` and `currentCallEpoch()`. Without these,
  // child agents inheriting a voice parent lose the ONLY supported way to
  // mint a current-epoch tag for server-initiated outbound after reconnect,
  // and every such send rejects with VoicePoisonedSessionError. Pure
  // read-only delegation — no attribution, no message rewrite — these
  // helpers don't produce wire traffic and don't mutate adapter state.
  const PARENT_READONLY_EXTENSIONS = ["stampForCurrentCall", "currentCallEpoch"] as const;
  for (const methodName of PARENT_READONLY_EXTENSIONS) {
    const original = (parentChannel as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      const fn = original as (...args: unknown[]) => unknown;
      child[methodName] = (...args: unknown[]): unknown => fn.apply(parentChannel, args);
    }
  }

  // Round-50/51 high: PRIVILEGED state-mutating extensions (e.g.
  // VoiceChannelAdapter.endCall which fences all turns for that session
  // on the parent — terminates the parent's active voice call). Stronger
  // than ordinary outbound: an output-only child must not be able to hang
  // up or poison the parent's live call (round-51 finding). Required:
  // full bidirectional channel access (`mode === "all"`). Output-only and
  // none are both blocked.
  const PARENT_PRIVILEGED_EXTENSIONS = ["endCall"] as const;
  for (const methodName of PARENT_PRIVILEGED_EXTENSIONS) {
    const original = (parentChannel as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      const fn = original as (...args: unknown[]) => unknown;
      child[methodName] = (...args: unknown[]): unknown => {
        if (resolved.mode !== "all") return undefined;
        return fn.apply(parentChannel, args);
      };
    }
  }
  return child as unknown as ChannelAdapter;
}
