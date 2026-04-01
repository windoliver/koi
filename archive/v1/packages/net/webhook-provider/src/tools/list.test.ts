import { describe, expect, test } from "bun:test";
import type { WebhookSummary } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockWebhookComponent } from "../test-helpers.js";
import { createListTool } from "./list.js";

describe("createListTool", () => {
  test("returns webhook summaries", async () => {
    const component = createMockWebhookComponent();
    const tool = createListTool(component, "webhook", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly webhooks: readonly WebhookSummary[];
    };

    expect(result.webhooks).toHaveLength(2);
    expect(result.webhooks[0]?.url).toBe("https://example.com/hook1");
    expect(result.webhooks[0]?.enabled).toBe(true);
    expect(result.webhooks[0]?.events).toContain("session.started");
  });

  test("descriptor has correct name and empty required", () => {
    const component = createMockWebhookComponent();
    const tool = createListTool(component, "wh", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("wh_list");
    expect(tool.policy.sandbox).toBe(true);

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toHaveLength(0);
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockWebhookComponent(),
      list: () => {
        throw new Error("service down");
      },
    };
    const tool = createListTool(component, "webhook", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("service down");
  });
});
