import { describe, expect, test } from "bun:test";
import { probeMcp } from "../../probes/mcp.js";
import type { McpServerDescriptor } from "../../types.js";

describe("probeMcp", () => {
  test("builds descriptors from data-related tools", async () => {
    const server: McpServerDescriptor = {
      name: "test-db",
      listTools: async () => [
        { name: "query", description: "Run SQL query against database" },
        { name: "echo", description: "Echo back input" },
      ],
    };

    const results = await probeMcp([server], 5000);

    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("mcp");
    expect(results[0]?.descriptor.name).toBe("mcp-test-db-query");
    expect(results[0]?.descriptor.protocol).toBe("mcp");
    expect(results[0]?.descriptor.description).toBe("Run SQL query against database");
  });

  test("filters non-data tools", async () => {
    const server: McpServerDescriptor = {
      name: "utils",
      listTools: async () => [
        { name: "format", description: "Format text" },
        { name: "calculate", description: "Do math" },
      ],
    };

    const results = await probeMcp([server], 5000);
    expect(results).toEqual([]);
  });

  test("returns empty results on timeout", async () => {
    const slowServer: McpServerDescriptor = {
      name: "slow",
      listTools: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ name: "query", description: "SQL query" }]), 500),
        ),
    };

    const results = await probeMcp([slowServer], 10);
    expect(results).toEqual([]);
  });

  test("returns empty results when listTools throws", async () => {
    const brokenServer: McpServerDescriptor = {
      name: "broken",
      listTools: async () => {
        throw new Error("Connection refused");
      },
    };

    const results = await probeMcp([brokenServer], 5000);
    expect(results).toEqual([]);
  });

  test("probes multiple servers in parallel", async () => {
    const server1: McpServerDescriptor = {
      name: "db1",
      listTools: async () => [{ name: "query-tables", description: "Query database tables" }],
    };
    const server2: McpServerDescriptor = {
      name: "db2",
      listTools: async () => [{ name: "select-rows", description: "Select rows from table" }],
    };

    const results = await probeMcp([server1, server2], 5000);
    expect(results).toHaveLength(2);
  });

  test("one failing server does not affect others", async () => {
    const goodServer: McpServerDescriptor = {
      name: "good",
      listTools: async () => [{ name: "run-sql", description: "Run SQL" }],
    };
    const badServer: McpServerDescriptor = {
      name: "bad",
      listTools: async () => {
        throw new Error("Crash");
      },
    };

    const results = await probeMcp([goodServer, badServer], 5000);
    expect(results).toHaveLength(1);
    expect(results[0]?.descriptor.name).toBe("mcp-good-run-sql");
  });
});
