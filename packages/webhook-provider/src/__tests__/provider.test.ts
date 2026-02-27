import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { toolToken, WEBHOOK } from "@koi/core";
import { createMockAgent, createMockWebhookComponent } from "../test-helpers.js";
import { createWebhookProvider } from "../webhook-component-provider.js";

describe("createWebhookProvider — attach", () => {
  test("provider name is 'webhook'", () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    expect(provider.name).toBe("webhook");
  });

  test("attaches all 2 tools by default", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    const components = await provider.attach(createMockAgent());

    // 2 tools + WEBHOOK token
    expect(components.size).toBe(3);
    expect(components.has(toolToken("webhook_list") as string)).toBe(true);
    expect(components.has(toolToken("webhook_status") as string)).toBe(true);
  });

  test("attaches the component under WEBHOOK token", async () => {
    const webhookComponent = createMockWebhookComponent();
    const provider = createWebhookProvider({ webhookComponent });
    const components = await provider.attach(createMockAgent());

    expect(components.get(WEBHOOK as string)).toBe(webhookComponent);
  });

  test("respects custom prefix", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
      prefix: "wh",
    });
    const components = await provider.attach(createMockAgent());

    expect(components.has(toolToken("wh_list") as string)).toBe(true);
    expect(components.has(toolToken("wh_status") as string)).toBe(true);
    expect(components.has(toolToken("webhook_list") as string)).toBe(false);
  });

  test("respects custom trust tier", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
      trustTier: "sandbox",
    });
    const components = await provider.attach(createMockAgent());

    const tool = components.get(toolToken("webhook_list") as string) as Tool;
    expect(tool.trustTier).toBe("sandbox");
  });

  test("respects operations filter", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
      operations: ["list"],
    });
    const components = await provider.attach(createMockAgent());

    // 1 tool + WEBHOOK token
    expect(components.size).toBe(2);
    expect(components.has(toolToken("webhook_list") as string)).toBe(true);
    expect(components.has(toolToken("webhook_status") as string)).toBe(false);
  });

  test("empty operations throws", () => {
    expect(() =>
      createWebhookProvider({
        webhookComponent: createMockWebhookComponent(),
        operations: [],
      }),
    ).toThrow(/operations must not be empty/);
  });
});

describe("createWebhookProvider — detach", () => {
  test("detach does not throw", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    await provider.detach?.(createMockAgent());
  });
});

describe("tool descriptors", () => {
  test("each tool has correct name and non-empty description", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    const components = await provider.attach(createMockAgent());

    const expectedNames = ["webhook_list", "webhook_status"];
    for (const name of expectedNames) {
      const tool = components.get(toolToken(name) as string) as Tool;
      expect(tool.descriptor.name).toBe(name);
      expect(tool.descriptor.description.length).toBeGreaterThan(0);
    }
  });
});
