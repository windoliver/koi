import { describe, expect, test } from "bun:test";
import { createMockMcpClientManager } from "../__tests__/mock-mcp-server.js";
import { createExecuteTool } from "./execute-tool.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExecuteTool", () => {
  test("creates tool with correct namespaced name", () => {
    const client = createMockMcpClientManager({ name: "api" });
    const tool = createExecuteTool("api", client);

    expect(tool.descriptor.name).toBe("mcp/api/mcp_execute");
  });

  test("has promoted trust tier", () => {
    const client = createMockMcpClientManager({ name: "api" });
    const tool = createExecuteTool("api", client);

    expect(tool.policy.sandbox).toBe(false);
  });

  test("returns validation error for missing tool field", async () => {
    const client = createMockMcpClientManager({ name: "api" });
    const tool = createExecuteTool("api", client);

    const result = (await tool.execute({})) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns validation error for empty tool name", async () => {
    const client = createMockMcpClientManager({ name: "api" });
    const tool = createExecuteTool("api", client);

    const result = (await tool.execute({ tool: "" })) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns validation error for non-string tool", async () => {
    const client = createMockMcpClientManager({ name: "api" });
    const tool = createExecuteTool("api", client);

    const result = (await tool.execute({ tool: 123 })) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };

    expect(result.ok).toBe(false);
  });

  test("delegates to client.callTool on valid input", async () => {
    const client = createMockMcpClientManager({
      name: "api",
      callResults: {
        my_tool: [{ type: "text", text: "result" }],
      },
    });
    const tool = createExecuteTool("api", client);

    const result = await tool.execute({
      tool: "my_tool",
      args: { key: "value" },
    });

    expect(result).toEqual([{ type: "text", text: "result" }]);
  });

  test("returns error when tool is not found", async () => {
    const client = createMockMcpClientManager({
      name: "api",
      callResults: {},
    });
    const tool = createExecuteTool("api", client);

    const result = (await tool.execute({ tool: "missing" })) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("handles missing args as empty object", async () => {
    const client = createMockMcpClientManager({
      name: "api",
      callResults: {
        no_args_tool: "ok",
      },
    });
    const tool = createExecuteTool("api", client);

    const result = await tool.execute({ tool: "no_args_tool" });
    expect(result).toBe("ok");
  });

  test("has correct input schema with required tool field", () => {
    const client = createMockMcpClientManager({ name: "api" });
    const tool = createExecuteTool("api", client);

    const schema = tool.descriptor.inputSchema as {
      readonly required?: readonly string[];
    };
    expect(schema.required).toContain("tool");
  });
});
