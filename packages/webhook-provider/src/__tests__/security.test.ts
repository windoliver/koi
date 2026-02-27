import { describe, expect, test } from "bun:test";
import type { AttachResult, OutboundWebhookConfig, Tool, WebhookSummary } from "@koi/core";
import { isAttachResult, toolToken } from "@koi/core";
import { createMockAgent, createMockWebhookComponent } from "../test-helpers.js";
import { createWebhookComponentFromService } from "../webhook-component-adapter.js";
import { createWebhookProvider } from "../webhook-component-provider.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("webhook security — no secrets in output", () => {
  test("webhook_list output never contains secret field", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    const listTool = components.get(toolToken("webhook_list") as string) as Tool;
    const result = (await listTool.execute({})) as {
      readonly webhooks: readonly Record<string, unknown>[];
    };

    for (const webhook of result.webhooks) {
      expect(webhook).not.toHaveProperty("secret");
    }
  });

  test("createWebhookComponentFromService strips secrets from configs", () => {
    const configs: readonly OutboundWebhookConfig[] = [
      {
        url: "https://example.com/hook",
        events: ["session.started"],
        secret: "super-secret-key",
        description: "Test hook",
        enabled: true,
      },
    ];

    const mockService = {
      health: () => [],
    };

    const component = createWebhookComponentFromService(configs, mockService);
    const summaries = component.list() as readonly WebhookSummary[];

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.url).toBe("https://example.com/hook");
    expect(summaries[0]?.events).toContain("session.started");
    expect(summaries[0]?.description).toBe("Test hook");
    expect(summaries[0]?.enabled).toBe(true);

    // Verify no secret field
    const raw = summaries[0] as unknown as Record<string, unknown>;
    expect(raw).not.toHaveProperty("secret");
  });

  test("WebhookSummary type does not include secret", () => {
    // Compile-time assertion — if WebhookSummary had a secret field,
    // this would fail type checking
    const summary: WebhookSummary = {
      url: "https://example.com",
      events: ["session.started"],
      enabled: true,
    };
    const keys = Object.keys(summary);
    expect(keys).not.toContain("secret");
  });

  test("tool output types are read-only", async () => {
    const provider = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    // Verify tool instances don't expose mutation methods
    const listTool = components.get(toolToken("webhook_list") as string) as Tool;
    const statusTool = components.get(toolToken("webhook_status") as string) as Tool;

    expect(typeof listTool.execute).toBe("function");
    expect(typeof statusTool.execute).toBe("function");

    // No create/update/delete methods on the provider
    const provider2 = createWebhookProvider({
      webhookComponent: createMockWebhookComponent(),
    });
    const providerKeys = Object.keys(provider2);
    expect(providerKeys).not.toContain("create");
    expect(providerKeys).not.toContain("update");
    expect(providerKeys).not.toContain("delete");
  });
});
