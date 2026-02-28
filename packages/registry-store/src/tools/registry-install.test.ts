import { describe, expect, test } from "bun:test";
import type { BrickArtifact, KoiError, Result, SkillArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createRegistryInstallTool } from "./registry-install.js";
import { createMockFacade } from "./test-helpers.js";

const TOOL_ARTIFACT: BrickArtifact = {
  id: brickId("brick_install-test"),
  kind: "tool",
  name: "install-test",
  description: "A test tool",
  scope: "agent",
  trustTier: "sandbox",
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "1.0.0",
  tags: ["test"],
  usageCount: 0,
  implementation: "return 1;",
  inputSchema: { type: "object" },
};

const SKILL_ARTIFACT: SkillArtifact = {
  id: brickId("brick_install-skill"),
  kind: "skill",
  name: "install-skill",
  description: "A test skill",
  scope: "agent",
  trustTier: "sandbox",
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "1.0.0",
  tags: ["test"],
  usageCount: 0,
  content: "# Test",
};

describe("registry_install tool", () => {
  test("returns NOT_FOUND for missing artifact", async () => {
    const facade = createMockFacade();
    const tool = createRegistryInstallTool(facade, "registry", "promoted");

    const result = (await tool.execute({ kind: "tool", name: "missing" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("NOT_FOUND");
  });

  test("calls onInstall callback and returns success", async () => {
    const facade = createMockFacade({
      bricks: {
        get: () => ({ ok: true, value: TOOL_ARTIFACT }),
      },
    });
    const onInstall = async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined });
    const tool = createRegistryInstallTool(facade, "registry", "promoted", onInstall);

    const result = (await tool.execute({ kind: "tool", name: "install-test" })) as Record<
      string,
      unknown
    >;
    expect(result.installed).toBe(true);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.name).toBe("install-test");
  });

  test("returns error from onInstall callback", async () => {
    const facade = createMockFacade({
      bricks: {
        get: () => ({ ok: true, value: TOOL_ARTIFACT }),
      },
    });
    const onInstall = async (): Promise<Result<void, KoiError>> => ({
      ok: false,
      error: { code: "INTERNAL", message: "Install failed", retryable: false },
    });
    const tool = createRegistryInstallTool(facade, "registry", "promoted", onInstall);

    const result = (await tool.execute({ kind: "tool", name: "install-test" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Install failed");
  });

  test("returns artifact data without onInstall (download-only)", async () => {
    const facade = createMockFacade({
      bricks: {
        get: () => ({ ok: true, value: TOOL_ARTIFACT }),
      },
    });
    const tool = createRegistryInstallTool(facade, "registry", "promoted");

    const result = (await tool.execute({ kind: "tool", name: "install-test" })) as Record<
      string,
      unknown
    >;
    expect(result.installed).toBe(false);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.name).toBe("install-test");
  });

  test("routes skill install through skills.install", async () => {
    const facade = createMockFacade({
      skills: {
        install: async () => ({ ok: true, value: SKILL_ARTIFACT }),
      },
    });
    const onInstall = async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined });
    const tool = createRegistryInstallTool(facade, "registry", "promoted", onInstall);

    const result = (await tool.execute({ kind: "skill", name: "install-skill" })) as Record<
      string,
      unknown
    >;
    expect(result.installed).toBe(true);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.name).toBe("install-skill");
    expect(artifact.kind).toBe("skill");
  });
});
