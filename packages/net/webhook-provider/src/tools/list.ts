/**
 * Tool factory for `webhook_list` — list configured webhooks (sanitized).
 */

import type { JsonObject, Tool, ToolPolicy, WebhookComponent } from "@koi/core";

export function createListTool(
  component: WebhookComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list`,
      description: "List configured webhook endpoints (secrets are never included).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (_args: JsonObject): Promise<unknown> => {
      try {
        const webhooks = await component.list();
        return { webhooks };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
