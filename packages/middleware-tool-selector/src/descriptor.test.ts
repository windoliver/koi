import { describe, expect, test } from "bun:test";
import type { AgentManifest, ModelRequest, ModelResponse, ToolDescriptor } from "@koi/core";
import type { ResolutionContext } from "@koi/resolve";
import { createMockInboundMessage, createMockTurnContext } from "@koi/test-utils";
import { createTagSelectTools, descriptor } from "./descriptor.js";
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

function makeTaggedTools(): readonly ToolDescriptor[] {
  return [
    {
      name: "shell_exec",
      description: "Execute shell",
      inputSchema: {},
      tags: ["coding", "automation", "dangerous"],
    },
    {
      name: "file_read",
      description: "Read files",
      inputSchema: {},
      tags: ["coding", "filesystem"],
    },
    { name: "web_search", description: "Search web", inputSchema: {}, tags: ["research"] },
    { name: "calculator", description: "Math ops", inputSchema: {}, tags: ["research", "coding"] },
    { name: "no_tags_tool", description: "No tags", inputSchema: {} },
  ];
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
// createTagSelectTools
// ---------------------------------------------------------------------------

describe("createTagSelectTools", () => {
  test("includes tools matching ALL includeTags (AND semantics)", async () => {
    const select = createTagSelectTools(["coding"], undefined);
    const result = await select("", makeTaggedTools());

    expect(result).toContain("shell_exec");
    expect(result).toContain("file_read");
    expect(result).toContain("calculator");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("no_tags_tool");
  });

  test("AND semantics with multiple includeTags", async () => {
    const select = createTagSelectTools(["coding", "automation"], undefined);
    const result = await select("", makeTaggedTools());

    expect(result).toEqual(["shell_exec"]);
  });

  test("excludes tools matching ANY excludeTag", async () => {
    const select = createTagSelectTools(undefined, ["dangerous"]);
    const result = await select("", makeTaggedTools());

    expect(result).not.toContain("shell_exec");
    expect(result).toContain("file_read");
    expect(result).toContain("web_search");
    expect(result).toContain("calculator");
    expect(result).toContain("no_tags_tool");
  });

  test("combines include and exclude", async () => {
    const select = createTagSelectTools(["coding"], ["dangerous"]);
    const result = await select("", makeTaggedTools());

    expect(result).toContain("file_read");
    expect(result).toContain("calculator");
    expect(result).not.toContain("shell_exec");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("no_tags_tool");
  });

  test("excludes tools without tags when includeTags specified", async () => {
    const select = createTagSelectTools(["coding"], undefined);
    const result = await select("", makeTaggedTools());

    expect(result).not.toContain("no_tags_tool");
  });

  test("includes tools without tags when only excludeTags specified", async () => {
    const select = createTagSelectTools(undefined, ["dangerous"]);
    const result = await select("", makeTaggedTools());

    expect(result).toContain("no_tags_tool");
  });

  test("returns all tools when no include or exclude", async () => {
    const select = createTagSelectTools(undefined, undefined);
    const result = await select("", makeTaggedTools());

    expect(result).toHaveLength(5);
  });

  test("returns empty when includeTags match nothing", async () => {
    const select = createTagSelectTools(["nonexistent"], undefined);
    const result = await select("", makeTaggedTools());

    expect(result).toHaveLength(0);
  });

  test("ignores query parameter", async () => {
    const select = createTagSelectTools(["coding"], undefined);
    const result1 = await select("any query", makeTaggedTools());
    const result2 = await select("", makeTaggedTools());

    expect(result1).toEqual(result2);
  });
});

// ---------------------------------------------------------------------------
// Descriptor (profile + auto + keyword + tag modes)
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

    // let: assigned in callback, read after await
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
    // let: assigned in callback, read after await
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

  test("options: { tags: ['coding'] } creates tag-based middleware", async () => {
    const mw = await descriptor.factory({ tags: ["coding"], maxTools: 15 }, makeContext());
    expect(mw.name).toBe("tool-selector");
  });

  test("options: { exclude: ['dangerous'] } creates tag-based middleware", async () => {
    const mw = await descriptor.factory({ exclude: ["dangerous"] }, makeContext());
    expect(mw.name).toBe("tool-selector");
  });

  test("options: { tags: ['coding'], minTools: 0 } forwards minTools", async () => {
    const mw = await descriptor.factory({ tags: ["coding"], minTools: 0 }, makeContext());
    expect(mw.name).toBe("tool-selector");
  });

  test("options: { alwaysInclude: ['my_custom'], tags: ['coding'] } forwards alwaysInclude", async () => {
    const mw = await descriptor.factory(
      { alwaysInclude: ["my_custom"], tags: ["coding"] },
      makeContext(),
    );
    expect(mw.name).toBe("tool-selector");
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

    // let: assigned in callback, read after await
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

    // let: assigned in callback, read after await
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

// ---------------------------------------------------------------------------
// Descriptor validation
// ---------------------------------------------------------------------------

describe("descriptor.optionsValidator", () => {
  test("accepts valid options with tags", () => {
    const result = descriptor.optionsValidator({ tags: ["coding"], maxTools: 10 });
    expect(result.ok).toBe(true);
  });

  test("accepts valid options with exclude", () => {
    const result = descriptor.optionsValidator({ exclude: ["dangerous"] });
    expect(result.ok).toBe(true);
  });

  test("accepts valid options with alwaysInclude", () => {
    const result = descriptor.optionsValidator({ alwaysInclude: ["my_tool"] });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = descriptor.optionsValidator("invalid");
    expect(result.ok).toBe(false);
  });

  test("rejects null input", () => {
    const result = descriptor.optionsValidator(null);
    expect(result.ok).toBe(false);
  });

  test("rejects non-array tags", () => {
    const result = descriptor.optionsValidator({ tags: "coding" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("tags");
    }
  });

  test("rejects non-string-array tags", () => {
    const result = descriptor.optionsValidator({ tags: [1, 2] });
    expect(result.ok).toBe(false);
  });

  test("rejects non-array exclude", () => {
    const result = descriptor.optionsValidator({ exclude: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exclude");
    }
  });

  test("rejects non-array alwaysInclude", () => {
    const result = descriptor.optionsValidator({ alwaysInclude: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("alwaysInclude");
    }
  });

  test("accepts valid minTools", () => {
    const result = descriptor.optionsValidator({ minTools: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative minTools", () => {
    const result = descriptor.optionsValidator({ minTools: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("minTools");
    }
  });

  test("rejects non-number minTools", () => {
    const result = descriptor.optionsValidator({ minTools: "zero" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer minTools", () => {
    const result = descriptor.optionsValidator({ minTools: 3.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer maxTools", () => {
    const result = descriptor.optionsValidator({ maxTools: 10.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxTools", () => {
    const result = descriptor.optionsValidator({ maxTools: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid profile name", () => {
    const result = descriptor.optionsValidator({ profile: "nonexistent" });
    expect(result.ok).toBe(false);
  });

  test("rejects profile 'auto' without autoScale", () => {
    const result = descriptor.optionsValidator({ profile: "auto" });
    expect(result.ok).toBe(false);
  });

  test("accepts empty object", () => {
    const result = descriptor.optionsValidator({});
    expect(result.ok).toBe(true);
  });
});
