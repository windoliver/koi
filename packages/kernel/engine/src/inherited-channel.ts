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

  // Round-40 medium: forward adapter-specific OUTBOUND extension methods
  // that bypass send() (e.g. MobileChannelAdapter.sendUnsolicited — the
  // ONLY explicit "deliver to currently connected socket" path on the
  // mobile adapter). These get attribution applied (just like send()).
  // Listed explicitly so plain-looking methods on the parent (`onMessage`,
  // `connect`) cannot be re-typed and accidentally forwarded — only
  // documented outbound extensions get the bypass.
  const PARENT_OUTBOUND_EXTENSIONS = ["sendUnsolicited"] as const;
  for (const methodName of PARENT_OUTBOUND_EXTENSIONS) {
    const original = (parentChannel as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      // Round-42 high: forward the full extension signature, not just the
      // first arg. `MobileChannelAdapter.sendUnsolicited(message, {recipient})`
      // uses the second argument to safely route mismatched-live or offline
      // sends through pushNotifier — dropping it silently breaks explicit
      // recipient targeting through composed/proxied paths.
      const fn = original as (message: OutboundMessage, ...rest: unknown[]) => Promise<void>;
      child[methodName] = (message: OutboundMessage, ...rest: unknown[]): Promise<void> => {
        if (resolved.mode === "none") return Promise.resolve();
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

  // Round-50 high: STATE-MUTATING extensions (e.g. VoiceChannelAdapter.endCall
  // which fences all turns for that session on the parent — terminates the
  // parent's active voice call). MUST honor spawn policy: a child given
  // `mode: "none"` (no channel access) must not be able to mutate the
  // parent's adapter state. Forwarding these without the gate violates the
  // channel-isolation contract — a no-channel child could cut off or poison
  // the parent's live call. Gated behind the same mode check as send().
  const PARENT_MUTATING_EXTENSIONS = ["endCall"] as const;
  for (const methodName of PARENT_MUTATING_EXTENSIONS) {
    const original = (parentChannel as unknown as Record<string, unknown>)[methodName];
    if (typeof original === "function") {
      const fn = original as (...args: unknown[]) => unknown;
      child[methodName] = (...args: unknown[]): unknown => {
        if (resolved.mode === "none") return undefined;
        return fn.apply(parentChannel, args);
      };
    }
  }
  return child as unknown as ChannelAdapter;
}
