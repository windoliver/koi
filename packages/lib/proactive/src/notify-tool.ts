/**
 * `notify` tool — fire-and-forget text message to an attached ChannelAdapter.
 *
 * Thin pass-through: validate args, look up adapter by name, build an
 * OutboundMessage with a single TextBlock, await `adapter.send`. No state,
 * no idempotency, no retries. Adapter dedupe is the adapter's concern.
 */

import type { JsonObject, OutboundMessage, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ResolveChannel } from "./types.js";

const schema = z.object({
  channel: z.string().min(1, "channel must be non-empty"),
  text: z.string().min(1, "text must be non-empty"),
  thread_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface NotifyToolConfig {
  readonly resolveChannel: ResolveChannel;
  /** Returns the currently-known channel names, used in error responses. */
  readonly names: () => readonly string[];
}

export function createNotifyTool(config: NotifyToolConfig): Tool {
  const { resolveChannel, names } = config;

  return {
    descriptor: {
      name: "notify",
      description:
        "Send a one-shot text message to the user via a named channel " +
        "(e.g. 'slack', 'email'). Fire-and-forget: no retries, no delivery " +
        "confirmation beyond `ok:true`. Returns `ok:false` with the list " +
        "of available channels if the named channel is not attached.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      const { channel, text, thread_id, metadata } = parsed.data;
      const adapter = resolveChannel(channel);
      if (adapter === undefined) {
        return {
          ok: false,
          error: `unknown channel: ${channel}`,
          available_channels: [...names()].sort(),
        };
      }
      const message: OutboundMessage = {
        content: [{ kind: "text", text }],
        ...(thread_id !== undefined ? { threadId: thread_id } : {}),
        ...(metadata !== undefined ? { metadata: metadata as JsonObject } : {}),
      };
      try {
        await adapter.send(message);
        return { ok: true };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "channel.send failed",
        };
      }
    },
  };
}
