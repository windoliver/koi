import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { runManifestChecks } from "./manifest-checks.js";

const VALID_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "1.0.0",
  model: { name: "test-model" },
};

const TIMEOUT = 5_000;

describe("runManifestChecks", () => {
  test("all checks pass for a valid manifest", async () => {
    const results = await runManifestChecks(VALID_MANIFEST, TIMEOUT);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.status).toBe("pass");
      expect(r.category).toBe("manifest");
    }
  });

  test("fails when name is empty", async () => {
    const manifest: AgentManifest = { ...VALID_MANIFEST, name: "" };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const nameCheck = results.find((r) => r.name.includes("name is non-empty"));
    expect(nameCheck?.status).toBe("fail");
    expect(nameCheck?.error?.message).toContain("non-empty");
  });

  test("fails when name is whitespace only", async () => {
    const manifest: AgentManifest = { ...VALID_MANIFEST, name: "   " };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const nameCheck = results.find((r) => r.name.includes("name is non-empty"));
    expect(nameCheck?.status).toBe("fail");
  });

  test("fails when version is empty", async () => {
    const manifest: AgentManifest = { ...VALID_MANIFEST, version: "" };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const versionCheck = results.find((r) => r.name.includes("version is non-empty"));
    expect(versionCheck?.status).toBe("fail");
  });

  test("fails when model.name is empty", async () => {
    const manifest: AgentManifest = { ...VALID_MANIFEST, model: { name: "" } };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const modelCheck = results.find((r) => r.name.includes("model config"));
    expect(modelCheck?.status).toBe("fail");
    expect(modelCheck?.error?.message).toContain("model.name");
  });

  test("passes with valid tool configs", async () => {
    const manifest: AgentManifest = {
      ...VALID_MANIFEST,
      tools: [{ name: "tool-a" }, { name: "tool-b" }],
    };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const toolCheck = results.find((r) => r.name.includes("tool configs"));
    expect(toolCheck?.status).toBe("pass");
  });

  test("fails when tool config has empty name", async () => {
    const manifest: AgentManifest = {
      ...VALID_MANIFEST,
      tools: [{ name: "" }],
    };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const toolCheck = results.find((r) => r.name.includes("tool configs"));
    expect(toolCheck?.status).toBe("fail");
  });

  test("passes when tools is undefined", async () => {
    const results = await runManifestChecks(VALID_MANIFEST, TIMEOUT);
    const toolCheck = results.find((r) => r.name.includes("tool configs"));
    expect(toolCheck?.status).toBe("pass");
  });

  test("fails when middleware config has empty name", async () => {
    const manifest: AgentManifest = {
      ...VALID_MANIFEST,
      middleware: [{ name: "" }],
    };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const mwCheck = results.find((r) => r.name.includes("middleware configs"));
    expect(mwCheck?.status).toBe("fail");
  });

  test("passes with valid middleware configs", async () => {
    const manifest: AgentManifest = {
      ...VALID_MANIFEST,
      middleware: [{ name: "audit" }, { name: "memory" }],
    };
    const results = await runManifestChecks(manifest, TIMEOUT);
    const mwCheck = results.find((r) => r.name.includes("middleware configs"));
    expect(mwCheck?.status).toBe("pass");
  });
});
