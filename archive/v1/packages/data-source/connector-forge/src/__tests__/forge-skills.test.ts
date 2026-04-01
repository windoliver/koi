import { describe, expect, test } from "bun:test";
import type { DataSourceDescriptor } from "@koi/core";
import { forgeDataSourceSkills } from "../forge-skills.js";

describe("forgeDataSourceSkills", () => {
  test("generates ForgeSkillInput for postgres descriptor", () => {
    const descriptors: readonly DataSourceDescriptor[] = [
      {
        name: "orders-db",
        protocol: "postgres",
        description: "Orders database",
        auth: { kind: "connection_string", ref: "ORDERS_DB_URL" },
      },
    ];

    const result = forgeDataSourceSkills(descriptors);

    expect(result.inputs).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    const input = result.inputs[0];
    if (input === undefined) throw new Error("expected input");
    expect(input.kind).toBe("skill");
    expect(input.name).toBe("datasource-orders-db");
    expect(input.description).toContain("PostgreSQL");
    expect(input.requires?.credentials?.["orders-db"]?.ref).toBe("ORDERS_DB_URL");
  });

  test("generates ForgeSkillInput for mcp descriptor", () => {
    const descriptors: readonly DataSourceDescriptor[] = [
      {
        name: "notion-mcp",
        protocol: "mcp",
        description: "Notion workspace via MCP",
      },
    ];

    const result = forgeDataSourceSkills(descriptors);

    expect(result.inputs).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    const input = result.inputs[0];
    if (input === undefined) throw new Error("expected input");
    expect(input.kind).toBe("skill");
    expect(input.name).toBe("datasource-notion-mcp");
    expect(input.description).toContain("MCP");
  });

  test("skips unknown protocol", () => {
    const descriptors: readonly DataSourceDescriptor[] = [
      {
        name: "redis-cache",
        protocol: "redis",
      },
    ];

    const result = forgeDataSourceSkills(descriptors);

    expect(result.inputs).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("redis-cache");
    expect(result.skipped[0]?.reason).toContain("No strategy for protocol");
  });

  test("all generated inputs have correct tags", () => {
    const descriptors: readonly DataSourceDescriptor[] = [
      { name: "pg", protocol: "postgres" },
      { name: "api", protocol: "http" },
      { name: "gql", protocol: "graphql" },
      { name: "mcp-tools", protocol: "mcp" },
    ];

    const result = forgeDataSourceSkills(descriptors);

    expect(result.inputs).toHaveLength(4);
    for (const input of result.inputs) {
      expect(input.tags).toBeDefined();
      expect(input.tags).toContain("datasource");
    }

    expect(result.inputs[0]?.tags).toContain("postgres");
    expect(result.inputs[1]?.tags).toContain("http");
    expect(result.inputs[2]?.tags).toContain("graphql");
    expect(result.inputs[3]?.tags).toContain("mcp");
  });
});
