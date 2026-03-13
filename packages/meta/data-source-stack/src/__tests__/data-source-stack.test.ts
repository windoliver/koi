import { describe, expect, test } from "bun:test";
import { createDataSourceStack } from "../data-source-stack.js";

describe("createDataSourceStack", () => {
  test("empty config returns empty results", async () => {
    const bundle = await createDataSourceStack({
      env: {},
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toEqual([]);
    expect(bundle.generatedSkillInputs).toEqual([]);
    expect(bundle.config.sourceCount).toBe(0);
    expect(bundle.config.generatedSkillCount).toBe(0);
  });

  test("manifest entries produce discovered sources and generated skills", async () => {
    const bundle = await createDataSourceStack({
      manifestEntries: [
        { name: "orders-db", protocol: "postgres", description: "Orders" },
        { name: "api", protocol: "http", description: "REST API" },
      ],
      env: {},
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(2);
    expect(bundle.generatedSkillInputs.length).toBeGreaterThanOrEqual(2);
    expect(bundle.config.sourceCount).toBe(2);
    expect(bundle.config.generatedSkillCount).toBeGreaterThanOrEqual(2);
    expect(bundle.config.probesEnabled.manifest).toBe(true);
  });

  test("generateSkills: false suppresses skill generation", async () => {
    const bundle = await createDataSourceStack({
      manifestEntries: [{ name: "orders-db", protocol: "postgres", description: "Orders" }],
      env: {},
      generateSkills: false,
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(1);
    expect(bundle.generatedSkillInputs).toEqual([]);
    expect(bundle.config.sourceCount).toBe(1);
    expect(bundle.config.generatedSkillCount).toBe(0);
  });

  test("provider is returned with correct name and attaches sources", async () => {
    const bundle = await createDataSourceStack({
      manifestEntries: [{ name: "orders-db", protocol: "postgres" }],
      env: {},
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.provider).toBeDefined();
    expect(bundle.provider.name).toBe("@koi/data-source-stack");

    // Verify provider.attach() returns discovered sources + skill components
    const attachResult = await bundle.provider.attach({} as never);
    expect(attachResult).toBeInstanceOf(Map);
    expect((attachResult as ReadonlyMap<string, unknown>).size).toBeGreaterThanOrEqual(1);
  });

  test("dispose function is callable", async () => {
    const bundle = await createDataSourceStack({
      env: {},
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(() => bundle.dispose()).not.toThrow();
  });

  test("probesEnabled reflects config", async () => {
    const bundle = await createDataSourceStack({
      manifestEntries: [{ name: "db", protocol: "postgres" }],
      mcpServers: [{ name: "s", listTools: async () => [] }],
      env: {},
    });

    expect(bundle.config.probesEnabled.manifest).toBe(true);
    expect(bundle.config.probesEnabled.env).toBe(true);
    expect(bundle.config.probesEnabled.mcp).toBe(true);
  });
});
