import { describe, expect, test } from "bun:test";
import type { WebhookEndpointHealth } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockWebhookComponent } from "../test-helpers.js";
import { createStatusTool } from "./status.js";

describe("createStatusTool", () => {
  test("returns all endpoint health data", async () => {
    const component = createMockWebhookComponent();
    const tool = createStatusTool(component, "webhook", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly endpoints: readonly WebhookEndpointHealth[];
    };

    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0]?.url).toBe("https://example.com/hook1");
    expect(result.endpoints[0]?.ok).toBe(true);
    expect(result.endpoints[1]?.circuitBreakerOpen).toBe(true);
  });

  test("filters by URL when provided", async () => {
    const component = createMockWebhookComponent();
    const tool = createStatusTool(component, "webhook", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ url: "https://example.com/hook2" })) as {
      readonly endpoints: readonly WebhookEndpointHealth[];
    };

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.url).toBe("https://example.com/hook2");
  });

  test("returns empty when URL filter matches nothing", async () => {
    const component = createMockWebhookComponent();
    const tool = createStatusTool(component, "webhook", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ url: "https://nonexistent.com" })) as {
      readonly endpoints: readonly WebhookEndpointHealth[];
    };

    expect(result.endpoints).toHaveLength(0);
  });

  test("descriptor has correct name", () => {
    const component = createMockWebhookComponent();
    const tool = createStatusTool(component, "wh", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("wh_status");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockWebhookComponent(),
      health: () => {
        throw new Error("health check failed");
      },
    };
    const tool = createStatusTool(component, "webhook", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("health check failed");
  });
});
