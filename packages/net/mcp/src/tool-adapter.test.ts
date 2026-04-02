import { describe, expect, test } from "bun:test";
import { createMockConnection } from "./__tests__/mock-connection.js";
import {
  mapMcpToolInfoToDescriptor,
  mapMcpToolToKoi,
  namespacedToolName,
  parseNamespacedToolName,
  validateServerName,
} from "./tool-adapter.js";

describe("validateServerName", () => {
  test("accepts normal server names", () => {
    expect(() => validateServerName("filesystem")).not.toThrow();
    expect(() => validateServerName("my-server")).not.toThrow();
    expect(() => validateServerName("server.with.dots")).not.toThrow();
  });

  test("rejects server names containing the namespace separator", () => {
    expect(() => validateServerName("prod__github")).toThrow(/namespace separator/);
    expect(() => validateServerName("a__b__c")).toThrow(/namespace separator/);
  });

  test("accepts names with single underscore", () => {
    expect(() => validateServerName("my_server")).not.toThrow();
  });
});

describe("namespacedToolName", () => {
  test("joins server and tool with double underscore", () => {
    expect(namespacedToolName("filesystem", "read_file")).toBe("filesystem__read_file");
  });

  test("handles server names with special characters", () => {
    expect(namespacedToolName("my-server", "my.tool")).toBe("my-server__my.tool");
  });
});

describe("parseNamespacedToolName", () => {
  test("parses valid namespaced name", () => {
    const result = parseNamespacedToolName("filesystem__read_file");
    expect(result).toEqual({ serverName: "filesystem", toolName: "read_file" });
  });

  test("returns undefined for name without separator", () => {
    expect(parseNamespacedToolName("no_separator")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseNamespacedToolName("")).toBeUndefined();
  });

  test("handles separator at start (invalid server name)", () => {
    // Separator at index 0 means empty server name — invalid
    expect(parseNamespacedToolName("__tool")).toBeUndefined();
  });

  test("handles multiple separators (takes first)", () => {
    const result = parseNamespacedToolName("server__ns__tool");
    expect(result).toEqual({ serverName: "server", toolName: "ns__tool" });
  });
});

describe("mapMcpToolInfoToDescriptor", () => {
  test("creates descriptor with namespaced name and server field", () => {
    const descriptor = mapMcpToolInfoToDescriptor(
      { name: "search", description: "Search things", inputSchema: { type: "object" } },
      "github",
    );
    expect(descriptor.name).toBe("github__search");
    expect(descriptor.description).toBe("Search things");
    expect(descriptor.server).toBe("github");
    expect(descriptor.origin).toBe("operator");
  });

  test("normalizes input schema", () => {
    const descriptor = mapMcpToolInfoToDescriptor(
      { name: "tool", description: "desc", inputSchema: {} },
      "srv",
    );
    expect(descriptor.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

describe("mapMcpToolToKoi", () => {
  test("creates Tool with correct origin and policy", () => {
    const conn = createMockConnection("test-server", [
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ]);
    const tool = mapMcpToolToKoi(
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      conn,
      "test-server",
    );
    expect(tool.origin).toBe("operator");
    expect(tool.policy.sandbox).toBe(false);
    expect(tool.descriptor.name).toBe("test-server__echo");
    expect(tool.descriptor.server).toBe("test-server");
  });

  test("execute delegates to connection callTool", async () => {
    const conn = createMockConnection("srv", [], {
      echo: { ok: true, value: [{ type: "text", text: "hello" }] },
    });
    const tool = mapMcpToolToKoi(
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      conn,
      "srv",
    );
    const result = await tool.execute({ msg: "hi" });
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  test("execute returns error result on callTool failure", async () => {
    const conn = createMockConnection("srv", [], {
      echo: { ok: false, error: { code: "EXTERNAL", message: "fail", retryable: false } },
    });
    const tool = mapMcpToolToKoi(
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      conn,
      "srv",
    );
    const result = await tool.execute({});
    expect(result).toEqual({ ok: false, error: { code: "EXTERNAL", message: "fail" } });
  });
});
