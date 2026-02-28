import { describe, expect, test } from "bun:test";
import type { AgentManifest, ModelRequest, ModelResponse, ToolDescriptor } from "@koi/core";
import type { ResolutionContext } from "@koi/resolve";
import { createMockInboundMessage, createMockTurnContext } from "@koi/test-utils";
import { descriptor } from "./descriptor.js";
import { TOOL_PROFILES } from "./tool-profiles.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(modelName = "claude-sonnet-4-5"): ResolutionContext {
  return {
    manifestDir: "/tmp",
    manifest: {
      name: "test-agent",
      version: "1.0.0",
      model: { name: modelName },
    } as AgentManifest,
    env: {},
  };
}

function makeTools(names: readonly string[]): readonly ToolDescriptor[] {
  return names.map((name) => ({ name, description: `Tool ${name}`, inputSchema: {} }));
}

function makeRequest(tools: readonly ToolDescriptor[], text = "hello"): ModelRequest {
  return {
    messages: [createMockInboundMessage({ text })],
    tools,
  };
}

function mockModelResponse(): ModelResponse {
  return { content: "ok", model: "test-model" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("descriptor", () => {
  test("has correct metadata", () => {
    expect(descriptor.kind).toBe("middleware");
    expect(descriptor.name).toBe("@koi/middleware-tool-selector");
    expect(descriptor.aliases).toContain("tool-selector");
  });

  test("options: {} creates backward-compatible keyword matcher", async () => {
    const mw = await descriptor.factory({}, makeContext());
    expect(mw.name).toBe("tool-selector");
  });

  test("options: { profile: 'coding' } filters to profile tools", async () => {
    const allTools = makeTools([
      ...TOOL_PROFILES.coding,
      "extra_tool_1",
      "extra_tool_2",
      "extra_tool_3",
      "extra_tool_4",
      "extra_tool_5",
      "extra_tool_6",
    ]);

    const mw = await descriptor.factory({ profile: "coding" }, makeContext());
    const ctx = createMockTurnContext();

    let receivedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(allTools), next);

    expect(receivedRequest).toBeDefined();
    const names = receivedRequest?.tools?.map((t: { readonly name: string }) => t.name) ?? [];
    // Should only contain tools from the coding profile
    for (const name of names) {
      expect(TOOL_PROFILES.coding).toContain(name);
    }
  });

  test("options: { profile: 'coding', autoScale: true } with haiku model caps tools", async () => {
    const allTools = makeTools([
      ...TOOL_PROFILES.coding,
      "extra_tool_1",
      "extra_tool_2",
      "extra_tool_3",
    ]);

    // Haiku model → minimal tier → maxTools: 5
    const mw = await descriptor.factory(
      { profile: "coding", autoScale: true },
      makeContext("claude-3-haiku-20240307"),
    );

    const ctx = createMockTurnContext();
    let receivedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    await mw.wrapModelCall?.(ctx, makeRequest(allTools), next);

    expect(receivedRequest).toBeDefined();
    // Coding has 7 tools but minimal tier caps at 5
    expect((receivedRequest?.tools ?? []).length).toBeLessThanOrEqual(5);
  });

  test("options: { profile: 'nonexistent' } fails validation", () => {
    const result = descriptor.optionsValidator({ profile: "nonexistent" });
    expect(result.ok).toBe(false);
  });

  test("options: { profile: 'auto' } without autoScale fails validation", () => {
    const result = descriptor.optionsValidator({ profile: "auto" });
    expect(result.ok).toBe(false);
  });

  test("options: { maxTools: -1 } fails validation", () => {
    const result = descriptor.optionsValidator({ maxTools: -1 });
    expect(result.ok).toBe(false);
  });

  test("options: null fails validation", () => {
    const result = descriptor.optionsValidator(null);
    expect(result.ok).toBe(false);
  });

  test("options: {} keyword matcher selects tools by name/description overlap", async () => {
    const tools = makeTools([
      "file_read",
      "web_search",
      "shell_exec",
      "memory_store",
      "file_write",
      "apply_patch",
    ]);
    const mw = await descriptor.factory({}, makeContext());
    const ctx = createMockTurnContext();

    let receivedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    // "file" should match file_read, file_write, and possibly apply_patch via description
    await mw.wrapModelCall?.(ctx, makeRequest(tools, "read the file content"), next);

    expect(receivedRequest).toBeDefined();
    const names = receivedRequest?.tools?.map((t: { readonly name: string }) => t.name) ?? [];
    expect(names).toContain("file_read");
  });

  test("options: {} keyword matcher passes all tools when query terms are short", async () => {
    const tools = makeTools([
      "file_read",
      "web_search",
      "shell_exec",
      "memory_store",
      "file_write",
      "apply_patch",
    ]);
    const mw = await descriptor.factory({}, makeContext());
    const ctx = createMockTurnContext();

    let receivedRequest: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      receivedRequest = req;
      return mockModelResponse();
    };

    // All terms are <= 2 chars, so keyword matcher returns all tools
    await mw.wrapModelCall?.(ctx, makeRequest(tools, "hi go"), next);

    expect(receivedRequest).toBeDefined();
    // All 6 tools pass through because no terms match (all terms too short)
    expect(receivedRequest?.tools).toHaveLength(6);
  });
});
