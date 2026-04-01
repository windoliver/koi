import { describe, expect, test } from "bun:test";
import type { DataSourceDescriptor } from "@koi/core";
import { discoverSources } from "../discovery.js";
import type { McpServerDescriptor } from "../types.js";

describe("discoverSources", () => {
  test("returns empty results for empty inputs", async () => {
    const results = await discoverSources({});
    expect(results).toEqual([]);
  });

  test("discovers from manifest entries", async () => {
    const results = await discoverSources({
      manifestEntries: [{ name: "orders", protocol: "postgres", description: "Orders DB" }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("orders");
    expect(results[0]?.protocol).toBe("postgres");
  });

  test("discovers from environment variables", async () => {
    const results = await discoverSources({
      env: { DATABASE_URL: "postgres://host/db" },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.protocol).toBe("postgres");
  });

  test("discovers from MCP servers", async () => {
    const server: McpServerDescriptor = {
      name: "db-server",
      listTools: async () => [{ name: "query", description: "Run SQL query" }],
    };

    const results = await discoverSources({
      mcpServers: [server],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.protocol).toBe("mcp");
  });

  test("runs all probes in parallel and merges results", async () => {
    const server: McpServerDescriptor = {
      name: "remote",
      listTools: async () => [{ name: "run-query", description: "Execute database query" }],
    };

    const results = await discoverSources({
      manifestEntries: [{ name: "users", protocol: "postgres" }],
      env: { CACHE_DATABASE_URL: "mysql://host/cache" },
      mcpServers: [server],
    });

    expect(results).toHaveLength(3);
  });

  test("dedup: manifest wins over env for same (protocol, name)", async () => {
    const results = await discoverSources({
      manifestEntries: [
        {
          name: "database-url",
          protocol: "postgres",
          description: "From manifest",
        },
      ],
      env: { DATABASE_URL: "postgres://host/db" },
    });

    // Both produce protocol:postgres with name "database-url" (env lowercases + replaces _)
    const pgResults = results.filter((r) => r.name === "database-url");
    expect(pgResults).toHaveLength(1);
    expect(pgResults[0]?.description).toBe("From manifest");
  });

  test("consent callback filters results", async () => {
    const approved = new Set(["orders"]);

    const results = await discoverSources({
      manifestEntries: [
        { name: "orders", protocol: "postgres" },
        { name: "analytics", protocol: "postgres" },
      ],
      consent: {
        approve: (descriptor: DataSourceDescriptor) => approved.has(descriptor.name),
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("orders");
  });

  test("consent callback supports async approval", async () => {
    const results = await discoverSources({
      manifestEntries: [{ name: "db1", protocol: "postgres" }],
      consent: {
        approve: async () => Promise.resolve(true),
      },
    });

    expect(results).toHaveLength(1);
  });

  test("MCP probe failure is non-fatal", async () => {
    const brokenServer: McpServerDescriptor = {
      name: "broken",
      listTools: async () => {
        throw new Error("Connection refused");
      },
    };

    const results = await discoverSources({
      manifestEntries: [{ name: "orders", protocol: "postgres" }],
      mcpServers: [brokenServer],
    });

    // Manifest result should still be present
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("orders");
  });

  test("respects enableEnvProbe=false", async () => {
    const results = await discoverSources({
      env: { DATABASE_URL: "postgres://host/db" },
      config: { enableEnvProbe: false },
    });

    expect(results).toEqual([]);
  });

  test("respects enableMcpProbe=false", async () => {
    const server: McpServerDescriptor = {
      name: "db",
      listTools: async () => [{ name: "query", description: "SQL query" }],
    };

    const results = await discoverSources({
      mcpServers: [server],
      config: { enableMcpProbe: false },
    });

    expect(results).toEqual([]);
  });
});
