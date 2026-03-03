/**
 * Tool factory for `webhook_status` — get health status of webhook endpoints.
 */

import type { JsonObject, Tool, TrustTier, WebhookComponent } from "@koi/core";

export function createStatusTool(
  component: WebhookComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_status`,
      description: "Get delivery health status for webhook endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Optional: filter to a specific endpoint URL",
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      try {
        const allEndpoints = await component.health();

        // Optional URL filter
        const urlFilter = args.url;
        if (typeof urlFilter === "string" && urlFilter.length > 0) {
          const filtered = allEndpoints.filter((ep) => ep.url === urlFilter);
          return { endpoints: filtered };
        }

        return { endpoints: allEndpoints };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
