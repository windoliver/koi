import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { resolveToolSchemaSource } from "./tool-schema.js";

function createAgentWithTools(
  tools: readonly { name: string; description: string }[],
): ReturnType<typeof createMockAgent> {
  const components = new Map<string, unknown>();
  for (const t of tools) {
    const tool: Tool = {
      descriptor: { name: t.name, description: t.description, inputSchema: { type: "object" } },
      trustTier: "sandbox",
      async execute() {
        return {};
      },
    };
    components.set(toolToken(t.name) as string, tool);
  }
  return createMockAgent({ components });
}

describe("resolveToolSchemaSource", () => {
  test("serializes all tool descriptors when no filter", async () => {
    const agent = createAgentWithTools([
      { name: "search", description: "Search the web" },
      { name: "read", description: "Read a file" },
    ]);

    const result = await resolveToolSchemaSource({ kind: "tool_schema" }, agent);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("search");
    expect(parsed[1].name).toBe("read");
  });

  test("filters tools by name when tools array specified", async () => {
    const agent = createAgentWithTools([
      { name: "search", description: "Search" },
      { name: "read", description: "Read" },
      { name: "write", description: "Write" },
    ]);

    const result = await resolveToolSchemaSource(
      { kind: "tool_schema", tools: ["search", "write"] },
      agent,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t: { name: string }) => t.name)).toEqual(["search", "write"]);
  });

  test("returns fallback text when no tools match", async () => {
    const agent = createMockAgent();
    const result = await resolveToolSchemaSource({ kind: "tool_schema" }, agent);
    expect(result.content).toBe("No tools available.");
  });

  test("uses custom label when provided", async () => {
    const agent = createMockAgent();
    const result = await resolveToolSchemaSource({ kind: "tool_schema", label: "My Tools" }, agent);
    expect(result.label).toBe("My Tools");
  });

  test("uses default label", async () => {
    const agent = createMockAgent();
    const result = await resolveToolSchemaSource({ kind: "tool_schema" }, agent);
    expect(result.label).toBe("Tool Schemas");
  });

  test("includes inputSchema in output", async () => {
    const agent = createAgentWithTools([{ name: "test", description: "Test tool" }]);

    const result = await resolveToolSchemaSource({ kind: "tool_schema" }, agent);
    const parsed = JSON.parse(result.content);
    expect(parsed[0].inputSchema).toEqual({ type: "object" });
  });
});
