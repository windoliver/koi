import { describe, expect, test } from "bun:test";
import type { Agent, EnvReader, JsonObject, Tool, ToolRegistration } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, isAttachResult, toolToken } from "@koi/core";
import { createProviderFromRegistration } from "./create-provider.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: {
      id: "test-agent" as import("@koi/core").AgentId,
      name: "test",
      type: "copilot",
      depth: 0,
    },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "created",
    component: (token) => components.get(token as string) as undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

function stubTool(name: string): Tool {
  return {
    descriptor: { name, description: `${name} tool`, inputSchema: {} },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async () => `${name} result`,
  };
}

function stubRegistration(overrides?: Partial<ToolRegistration>): ToolRegistration {
  return {
    name: "test-provider",
    tools: [
      { name: "tool_a", create: () => stubTool("tool_a") },
      { name: "tool_b", create: () => stubTool("tool_b") },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createProviderFromRegistration
// ---------------------------------------------------------------------------

describe("createProviderFromRegistration", () => {
  test("attaches all tools when no availability check is defined", async () => {
    const reg = stubRegistration();
    const provider = createProviderFromRegistration(reg);
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(2);
    expect(result.components.has(toolToken("tool_a") as string)).toBe(true);
    expect(result.components.has(toolToken("tool_b") as string)).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  test("has correct provider name and priority", () => {
    const reg = stubRegistration({ name: "my-tools" });
    const provider = createProviderFromRegistration(reg);
    expect(provider.name).toBe("my-tools");
    expect(provider.priority).toBe(100); // COMPONENT_PRIORITY.BUNDLED
  });

  // --- Availability edge cases ---

  test("registers tools when env var is present (happy path)", async () => {
    const reg = stubRegistration({
      checkAvailability: (env: EnvReader) => env.API_KEY !== undefined,
    });
    const env: EnvReader = { API_KEY: "secret-123" };
    const provider = createProviderFromRegistration(reg, undefined, env);
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(2);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips all tools when env var is missing", async () => {
    const reg = stubRegistration({
      checkAvailability: (env: EnvReader) => env.API_KEY !== undefined,
    });
    const env: EnvReader = {};
    const provider = createProviderFromRegistration(reg, undefined, env);
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.reason).toContain("Availability check failed");
  });

  test("handles async availability check that resolves to true", async () => {
    const reg = stubRegistration({
      checkAvailability: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return true;
      },
    });
    const provider = createProviderFromRegistration(reg, undefined, {});
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(2);
  });

  test("fail-closed when availability check throws", async () => {
    const reg = stubRegistration({
      checkAvailability: () => {
        throw new Error("Network unreachable");
      },
    });
    const provider = createProviderFromRegistration(reg, undefined, {});
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(2);
  });

  test("fail-closed when async availability check rejects", async () => {
    const reg = stubRegistration({
      checkAvailability: async () => {
        throw new Error("Service unavailable");
      },
    });
    const provider = createProviderFromRegistration(reg, undefined, {});
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(2);
  });

  test("fail-closed when availability check times out", async () => {
    const reg = stubRegistration({
      checkAvailability: async () => {
        // Simulate a very slow check — longer than the timeout
        await new Promise((r) => setTimeout(r, 10_000));
        return true;
      },
    });
    // Use a very short timeout for the test
    const provider = createProviderFromRegistration(reg, undefined, {}, 50);
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(2);
  });

  test("partial availability: registers available tools, skips failing ones", async () => {
    const reg = stubRegistration({
      tools: [
        { name: "good_tool", create: () => stubTool("good_tool") },
        {
          name: "bad_tool",
          create: () => {
            throw new Error("Missing dependency");
          },
        },
      ],
    });
    const provider = createProviderFromRegistration(reg);
    const result = await provider.attach(stubAgent());

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(1);
    expect(result.components.has(toolToken("good_tool") as string)).toBe(true);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("bad_tool");
    expect(result.skipped[0]?.reason).toContain("Missing dependency");
  });

  test("passes options to tool factory create()", async () => {
    const receivedOptions: JsonObject[] = [];
    const reg = stubRegistration({
      tools: [
        {
          name: "configurable_tool",
          create: (_agent: Agent, opts?: JsonObject) => {
            if (opts !== undefined) receivedOptions.push(opts);
            return stubTool("configurable_tool");
          },
        },
      ],
    });
    const opts: JsonObject = { debug: true };
    const provider = createProviderFromRegistration(reg, opts);
    await provider.attach(stubAgent());

    expect(receivedOptions).toHaveLength(1);
    expect(receivedOptions[0]).toEqual({ debug: true });
  });
});
