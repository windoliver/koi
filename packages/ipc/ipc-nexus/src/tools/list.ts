/**
 * Tool factory for ipc_list — list messages in the agent's inbox.
 */

import type {
  JsonObject,
  MailboxComponent,
  MessageFilter,
  MessageKind,
  Tool,
  TrustTier,
} from "@koi/core";
import { agentId } from "@koi/core";

const VALID_KINDS = new Set<string>(["request", "response", "event", "cancel"]);

export function createListTool(
  component: MailboxComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list`,
      description: "List messages in the agent's inbox with optional filtering.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Filter by message kind: request, response, event, or cancel",
          },
          type: {
            type: "string",
            description: "Filter by application-level message type",
          },
          from: {
            type: "string",
            description: "Filter by sender agent ID",
          },
          limit: {
            type: "number",
            description: "Maximum number of messages to return",
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const filter: MessageFilter = {
        ...(typeof args.kind === "string" && VALID_KINDS.has(args.kind)
          ? { kind: args.kind as MessageKind }
          : {}),
        ...(typeof args.type === "string" ? { type: args.type } : {}),
        ...(typeof args.from === "string" ? { from: agentId(args.from) } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      };

      try {
        const messages = await component.list(filter);
        return { messages };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
