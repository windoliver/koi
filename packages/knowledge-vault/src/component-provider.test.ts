import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AttachResult } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createKnowledgeVaultProvider } from "./component-provider.js";
import type { KnowledgeComponent, KnowledgeVaultConfig } from "./types.js";
import { KNOWLEDGE } from "./types.js";

const tempDirs: string[] = [];

async function createTestVault(
  docs: readonly { readonly path: string; readonly content: string }[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kv-cp-"));
  tempDirs.push(dir);
  for (const doc of docs) {
    await Bun.write(join(dir, doc.path), doc.content);
  }
  return dir;
}

// Agent stub — attach() ignores the agent param, so cast is safe
const stubAgent = {} as Agent;

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("createKnowledgeVaultProvider", () => {
  test("creates provider with correct name", () => {
    const config: KnowledgeVaultConfig = { sources: [] };
    const provider = createKnowledgeVaultProvider(config);
    expect(provider.name).toBe("knowledge-vault");
  });

  test("attach returns KNOWLEDGE component with valid service", async () => {
    const dir = await createTestVault([
      {
        path: "doc.md",
        content: "---\ntitle: Test Doc\ntags: [test]\n---\nTest content about testing.",
      },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);

    expect(isAttachResult(result)).toBe(true);
    const attachResult = result as AttachResult;
    expect(attachResult.skipped).toHaveLength(0);

    const component = attachResult.components.get(KNOWLEDGE as string) as KnowledgeComponent;
    expect(component).toBeDefined();
    expect(component.sources).toHaveLength(1);

    // Verify query works
    const docs = await component.query("testing");
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });

  test("attach returns skipped component on failure", async () => {
    const config: KnowledgeVaultConfig = {
      sources: [
        {
          kind: "directory",
          path: "/nonexistent/path/that/does/not/exist",
        },
      ],
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);

    // Even with a bad path, service creation succeeds (0 docs + warnings)
    expect(isAttachResult(result)).toBe(true);
    const attachResult = result as AttachResult;
    // The directory scan may produce 0 docs but not fail entirely
    expect(attachResult.components.has(KNOWLEDGE as string)).toBe(true);
  });

  test("detach is a no-op", async () => {
    const config: KnowledgeVaultConfig = { sources: [] };
    const provider = createKnowledgeVaultProvider(config);
    // Should not throw
    await provider.detach?.(stubAgent);
  });

  test("refresh rebuilds knowledge component state", async () => {
    const dir = await createTestVault([
      { path: "initial.md", content: "Initial content about auth." },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [{ kind: "directory", path: dir }],
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);
    const attachResult = result as AttachResult;
    const component = attachResult.components.get(KNOWLEDGE as string) as KnowledgeComponent;

    expect(component.sources[0]?.documentCount).toBe(1);

    // Add a file and refresh
    await Bun.write(join(dir, "new.md"), "New content about deployment.");
    const refreshResult = await component.refresh();
    expect(refreshResult.documentCount).toBe(2);
  });

  test("provider surfaces source descriptions", async () => {
    const dir = await createTestVault([
      { path: "doc.md", content: "Test content about security." },
    ]);

    const config: KnowledgeVaultConfig = {
      sources: [
        {
          kind: "directory",
          path: dir,
          name: "security-docs",
          description: "Security documentation for the platform",
        },
      ],
    };

    const provider = createKnowledgeVaultProvider(config);
    const result = await provider.attach(stubAgent);
    const attachResult = result as AttachResult;
    const component = attachResult.components.get(KNOWLEDGE as string) as KnowledgeComponent;

    expect(component).toBeDefined();
    expect(component.sources).toHaveLength(1);
    expect(component.sources[0]?.name).toBe("security-docs");
    expect(component.sources[0]?.description).toBe("Security documentation for the platform");
  });
});
