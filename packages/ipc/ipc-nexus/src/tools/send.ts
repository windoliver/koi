/**
 * Tool factory for ipc_send — dispatch a message to another agent's mailbox.
 */

import type {
  AgentMessageInput,
  JsonObject,
  MailboxComponent,
  MessageKind,
  Tool,
  ToolPolicy,
} from "@koi/core";
import { agentId, messageId } from "@koi/core";

const VALID_KINDS = new Set<string>(["request", "response", "event", "cancel"]);

export function createSendTool(
  component: MailboxComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_send`,
      description: "Send a message to another agent's mailbox.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender agent ID" },
          to: { type: "string", description: "Recipient agent ID" },
          kind: {
            type: "string",
            description: "Message kind: request, response, event, or cancel",
          },
          type: { type: "string", description: "Application-level message type" },
          payload: { type: "object", description: "Message payload" },
          correlationId: {
            type: "string",
            description: "Optional correlation ID for request/response pairing",
          },
          ttlSeconds: {
            type: "number",
            description: "Optional time-to-live in seconds",
          },
          metadata: { type: "object", description: "Optional message metadata" },
        },
        required: ["from", "to", "kind", "type", "payload"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const from = args.from;
      const to = args.to;
      const kind = args.kind;
      const type = args.type;
      const payload = args.payload;

      if (
        typeof from !== "string" ||
        typeof to !== "string" ||
        typeof kind !== "string" ||
        typeof type !== "string"
      ) {
        return { error: "from, to, kind, and type must be strings", code: "VALIDATION" };
      }

      if (!VALID_KINDS.has(kind)) {
        return {
          error: `Invalid kind: ${kind}. Must be one of: request, response, event, cancel`,
          code: "VALIDATION",
        };
      }

      if (typeof payload !== "object" || payload === null) {
        return { error: "payload must be an object", code: "VALIDATION" };
      }

      const message: AgentMessageInput = {
        from: agentId(from),
        to: agentId(to),
        kind: kind as MessageKind,
        type,
        payload: payload as JsonObject,
        ...(typeof args.correlationId === "string"
          ? { correlationId: messageId(args.correlationId) }
          : {}),
        ...(typeof args.ttlSeconds === "number" ? { ttlSeconds: args.ttlSeconds } : {}),
        ...(typeof args.metadata === "object" && args.metadata !== null
          ? { metadata: args.metadata as JsonObject }
          : {}),
      };

      const result = await component.send(message);
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      return { message: result.value };
    },
  };
}
