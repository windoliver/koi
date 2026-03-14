import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexusClient } from "@koi/nexus-client";
import { getPack, listPacks, PACK_IDS, runSeed } from "./seed.js";
import type { SeedContext } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "demo-packs-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Creates a NexusClient mock whose rpc always returns an error. */
function makeFailingClient(): NexusClient {
  return {
    rpc: async () => ({
      ok: false as const,
      error: {
        code: "EXTERNAL" as const,
        message: "Connection refused (mock)",
        retryable: false,
      },
    }),
  };
}

function makeCtx(overrides?: Partial<SeedContext>): SeedContext {
  return {
    nexusClient: makeFailingClient(),
    agentName: "test-agent",
    workspaceRoot: tempDir,
    verbose: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("PACK_IDS", () => {
  test("contains base, connected, and self-improvement", () => {
    expect(PACK_IDS).toContain("base");
    expect(PACK_IDS).toContain("connected");
    expect(PACK_IDS).toContain("self-improvement");
  });
});

describe("getPack", () => {
  test("returns pack for known ID", () => {
    const pack = getPack("base");
    expect(pack).toBeDefined();
    expect(pack?.id).toBe("base");
  });

  test("returns undefined for unknown ID", () => {
    expect(getPack("nonexistent")).toBeUndefined();
  });
});

describe("listPacks", () => {
  test("returns all registered packs", () => {
    const packs = listPacks();
    expect(packs.length).toBe(PACK_IDS.length);
    const ids = packs.map((p) => p.id);
    expect(ids).toContain("base");
    expect(ids).toContain("connected");
    expect(ids).toContain("self-improvement");
  });

  test("each pack has required fields", () => {
    for (const pack of listPacks()) {
      expect(typeof pack.id).toBe("string");
      expect(typeof pack.name).toBe("string");
      expect(typeof pack.description).toBe("string");
      expect(typeof pack.seed).toBe("function");
      expect(Array.isArray(pack.prompts)).toBe(true);
      expect(Array.isArray(pack.requires)).toBe(true);
      expect(Array.isArray(pack.agentRoles)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Base pack seed
// ---------------------------------------------------------------------------

describe("base pack", () => {
  test("creates .koi directory and INSTRUCTIONS.md", async () => {
    const ctx = makeCtx();
    const pack = getPack("base");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    const result = await pack.seed(ctx);

    expect(result.ok).toBe(true);
    expect(result.counts.files).toBe(1);
    expect(result.summary.length).toBeGreaterThan(0);

    const instructionsPath = join(tempDir, ".koi", "INSTRUCTIONS.md");
    expect(existsSync(instructionsPath)).toBe(true);

    const content = readFileSync(instructionsPath, "utf-8");
    expect(content).toContain("test-agent");
    expect(content).toContain("demo mode");
  });

  test("does not overwrite existing INSTRUCTIONS.md", async () => {
    const ctx = makeCtx();
    const pack = getPack("base");
    expect(pack).toBeDefined();
    if (pack === undefined) return;

    // Seed once
    await pack.seed(ctx);
    const instructionsPath = join(tempDir, ".koi", "INSTRUCTIONS.md");
    const originalContent = readFileSync(instructionsPath, "utf-8");

    // Seed again with different agent name
    const ctx2 = makeCtx({ agentName: "different-agent" });
    await pack.seed(ctx2);

    // Content should not have changed
    const afterContent = readFileSync(instructionsPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  test("includes file paths in verbose mode", async () => {
    const ctx = makeCtx({ verbose: true });
    const pack = getPack("base");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    const result = await pack.seed(ctx);

    expect(result.summary.some((s) => s.includes("INSTRUCTIONS.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Connected pack seed
// ---------------------------------------------------------------------------

describe("connected pack", () => {
  test("returns failure when nexus client cannot connect", async () => {
    const ctx = makeCtx();
    const pack = getPack("connected");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    const result = await pack.seed(ctx);

    // Mock rpc returns errors, so seeding fails
    expect(result.ok).toBe(false);
    expect(result.counts.memory).toBe(0);
    expect(result.counts.corpus).toBe(0);
  });

  test("includes warnings in verbose mode", async () => {
    const ctx = makeCtx({ verbose: true });
    const pack = getPack("connected");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    const result = await pack.seed(ctx);

    expect(result.summary.some((s) => s.includes("warn:"))).toBe(true);
  });

  test("has agent roles defined", () => {
    const pack = getPack("connected");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    expect(pack.agentRoles.length).toBeGreaterThan(0);
    expect(pack.agentRoles.some((r) => r.type === "copilot")).toBe(true);
    expect(pack.agentRoles.some((r) => r.type === "worker")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSeed
// ---------------------------------------------------------------------------

describe("runSeed", () => {
  test("returns error for unknown pack ID", async () => {
    const ctx = makeCtx();
    const result = await runSeed("unknown-pack-id", ctx);
    expect(result.ok).toBe(false);
    expect(result.summary[0]).toContain("Unknown demo pack");
  });

  test("runs base pack directly without double-running", async () => {
    const ctx = makeCtx();
    const result = await runSeed("base", ctx);

    expect(result.ok).toBe(true);
    expect(result.counts.files).toBe(1);
  });

  test("runs base pack before connected pack", async () => {
    const ctx = makeCtx();
    const result = await runSeed("connected", ctx);

    // Base pack should have run (files count from base)
    expect(result.counts.files).toBe(1);
    // Connected pack counts should be merged in
    expect("memory" in result.counts).toBe(true);
    expect("corpus" in result.counts).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-improvement pack
// ---------------------------------------------------------------------------

describe("self-improvement pack", () => {
  test("has valid pack metadata", () => {
    const pack = getPack("self-improvement");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    expect(pack.id).toBe("self-improvement");
    expect(pack.name).toBe("Self-Improvement");
    expect(pack.prompts.length).toBeGreaterThan(0);
    expect(pack.agentRoles.length).toBeGreaterThan(0);
  });

  test("only has primary agent role", () => {
    const pack = getPack("self-improvement");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    expect(pack.agentRoles.length).toBe(1);
    expect(pack.agentRoles[0]?.name).toBe("primary");
  });

  test("returns failure when nexus client cannot connect", async () => {
    const ctx = makeCtx();
    const pack = getPack("self-improvement");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    const result = await pack.seed(ctx);

    expect(result.ok).toBe(false);
    expect(result.counts.forgeEvents).toBe(0);
    expect(result.counts.bricks).toBe(0);
    expect(result.counts.fitnessHistory).toBe(0);
  });

  test("includes warnings in verbose mode", async () => {
    const ctx = makeCtx({ verbose: true });
    const pack = getPack("self-improvement");
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    const result = await pack.seed(ctx);

    expect(result.summary.some((s) => s.includes("warn:"))).toBe(true);
  });

  test("runs base pack before self-improvement via runSeed", async () => {
    const ctx = makeCtx();
    const result = await runSeed("self-improvement", ctx);

    // Base pack should have run (files count from base)
    expect(result.counts.files).toBe(1);
    // Self-improvement pack counts should be merged in
    expect("forgeEvents" in result.counts).toBe(true);
    expect("bricks" in result.counts).toBe(true);
    expect("fitnessHistory" in result.counts).toBe(true);
  });
});
