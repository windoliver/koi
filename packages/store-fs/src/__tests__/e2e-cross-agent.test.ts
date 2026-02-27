/**
 * E2E cross-agent brick reuse test (Issue #65, Phase 4).
 *
 * Validates that two agents sharing a "shared" tier can:
 * 1. Each forge bricks into their own agent tier
 * 2. Promote a brick from agent -> shared tier
 * 3. The other agent can discover and use the promoted brick
 * 4. Agent-scoped bricks remain isolated (not visible to other agent)
 * 5. Scope-based promotion (ForgeScope -> tier mapping) works end-to-end
 *
 * @koi/forge is a devDependency (test-only, no layer violation).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AttachResult,
  BrickArtifact,
  ForgeProvenance,
  ForgeScope,
  SandboxExecutor,
  TieredSandboxExecutor,
  ToolArtifact,
} from "@koi/core";
import { brickId, isAttachResult } from "@koi/core";
import type { ForgeDeps } from "@koi/forge";
import {
  createDefaultForgeConfig,
  createForgeComponentProvider,
  createPromoteForgeTool,
} from "@koi/forge";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import type { OverlayConfig, OverlayForgeStore } from "../overlay-store.js";
import { createOverlayForgeStore } from "../overlay-store.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

async function freshDir(): Promise<string> {
  testCounter += 1;
  const dir = join(tmpdir(), `koi-e2e-cross-agent-${Date.now()}-${testCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
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

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId(`brick_${crypto.randomUUID()}`),
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return input;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function provenanceFor(agentId: string): ForgeProvenance {
  return {
    ...DEFAULT_PROVENANCE,
    source: { origin: "forged", forgedBy: agentId },
    metadata: { ...DEFAULT_PROVENANCE.metadata, agentId },
  };
}

interface CrossAgentSetup {
  readonly agentAlphaStore: OverlayForgeStore;
  readonly agentBetaStore: OverlayForgeStore;
  readonly sharedDir: string;
}

/**
 * Create two overlay stores that share the "shared" tier but have
 * separate agent tiers. This simulates two agents on the same machine.
 */
async function createCrossAgentSetup(): Promise<CrossAgentSetup> {
  const base = await freshDir();
  const sharedDir = join(base, "shared");
  const extensionsDir = join(base, "extensions");
  const bundledDir = join(base, "bundled");

  const alphaConfig: OverlayConfig = {
    tiers: [
      { name: "agent", access: "read-write", baseDir: join(base, "agents", "alpha", "bricks") },
      { name: "shared", access: "read-write", baseDir: sharedDir },
      { name: "extensions", access: "read-only", baseDir: extensionsDir },
      { name: "bundled", access: "read-only", baseDir: bundledDir },
    ],
  };

  const betaConfig: OverlayConfig = {
    tiers: [
      { name: "agent", access: "read-write", baseDir: join(base, "agents", "beta", "bricks") },
      { name: "shared", access: "read-write", baseDir: sharedDir },
      { name: "extensions", access: "read-only", baseDir: extensionsDir },
      { name: "bundled", access: "read-only", baseDir: bundledDir },
    ],
  };

  const agentAlphaStore = await createOverlayForgeStore(alphaConfig);
  const agentBetaStore = await createOverlayForgeStore(betaConfig);

  return { agentAlphaStore, agentBetaStore, sharedDir };
}

function createDeps(store: OverlayForgeStore, agentId: string): ForgeDeps {
  return {
    store,
    executor: mockTiered(echoExecutor()),
    verifiers: [],
    config: createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    }),
    context: {
      agentId,
      depth: 0,
      sessionId: `session-${agentId}`,
      forgesThisSession: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-agent brick reuse e2e", () => {
  let setup: CrossAgentSetup;

  beforeEach(async () => {
    setup = await createCrossAgentSetup();
  });

  // -----------------------------------------------------------------------
  // Test 1: Agent-scoped bricks are isolated between agents
  // -----------------------------------------------------------------------

  test("agent-scoped bricks are not visible to other agents", async () => {
    const { agentAlphaStore, agentBetaStore } = setup;

    // Alpha saves a brick to its agent tier
    const alphaBrick = createToolBrick({
      id: brickId("brick_alpha_private"),
      name: "alpha-private",
      provenance: provenanceFor("alpha"),
    });
    await agentAlphaStore.save(alphaBrick);

    // Alpha can see it
    const alphaExists = await agentAlphaStore.exists(brickId("brick_alpha_private"));
    expect(alphaExists.ok && alphaExists.value).toBe(true);

    // Beta cannot see it (different agent tier directory)
    const betaExists = await agentBetaStore.exists(brickId("brick_alpha_private"));
    expect(betaExists.ok && betaExists.value).toBe(false);

    // Alpha search returns it
    const alphaSearch = await agentAlphaStore.search({ kind: "tool" });
    expect(alphaSearch.ok).toBe(true);
    if (alphaSearch.ok) {
      expect(
        alphaSearch.value.some((b: BrickArtifact) => b.id === brickId("brick_alpha_private")),
      ).toBe(true);
    }

    // Beta search does not return it
    const betaSearch = await agentBetaStore.search({ kind: "tool" });
    expect(betaSearch.ok).toBe(true);
    if (betaSearch.ok) {
      expect(
        betaSearch.value.some((b: BrickArtifact) => b.id === brickId("brick_alpha_private")),
      ).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: Promote brick from agent -> shared tier, other agent can see it
  // -----------------------------------------------------------------------

  test("promoted brick becomes visible to other agent via shared tier", async () => {
    const { agentAlphaStore, agentBetaStore } = setup;

    // Alpha saves a brick to agent tier
    const sharedBrick = createToolBrick({
      id: brickId("brick_to_share"),
      name: "shared-calculator",
      provenance: provenanceFor("alpha"),
      trustTier: "verified",
    });
    await agentAlphaStore.save(sharedBrick);

    // Before promotion: beta cannot see it
    const beforeBeta = await agentBetaStore.exists(brickId("brick_to_share"));
    expect(beforeBeta.ok && beforeBeta.value).toBe(false);

    // Alpha promotes to shared tier
    const promoteResult = await agentAlphaStore.promoteTier(brickId("brick_to_share"), "shared");
    expect(promoteResult.ok).toBe(true);

    // Verify brick moved from agent to shared
    const locateAlpha = await agentAlphaStore.locateTier(brickId("brick_to_share"));
    expect(locateAlpha.ok).toBe(true);
    if (locateAlpha.ok) {
      expect(locateAlpha.value).toBe("shared");
    }

    // Now beta needs a fresh overlay store to see the new shared brick
    // (simulates cache refresh / new session)
    const betaRefreshed = await createOverlayForgeStore({
      tiers: [
        {
          name: "agent",
          access: "read-write",
          baseDir: join(setup.sharedDir, "..", "agents", "beta", "bricks"),
        },
        { name: "shared", access: "read-write", baseDir: setup.sharedDir },
      ],
    });

    // After promotion: beta can see it through the shared tier
    const afterBeta = await betaRefreshed.exists(brickId("brick_to_share"));
    expect(afterBeta.ok && afterBeta.value).toBe(true);

    // Beta can load the full brick
    const betaLoad = await betaRefreshed.load(brickId("brick_to_share"));
    expect(betaLoad.ok).toBe(true);
    if (betaLoad.ok) {
      expect(betaLoad.value.name).toBe("shared-calculator");
      expect(betaLoad.value.provenance.metadata.agentId).toBe("alpha");
    }

    // Beta search returns it
    const betaSearch = await betaRefreshed.search({ kind: "tool" });
    expect(betaSearch.ok).toBe(true);
    if (betaSearch.ok) {
      expect(betaSearch.value.some((b: BrickArtifact) => b.id === brickId("brick_to_share"))).toBe(
        true,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Scope-based promote (ForgeScope -> tier mapping)
  // -----------------------------------------------------------------------

  test("scope-based promote maps zone scope to shared tier", async () => {
    const { agentAlphaStore } = setup;

    const brick = createToolBrick({
      id: brickId("brick_scope_promote"),
      name: "scope-promoted",
      provenance: provenanceFor("alpha"),
    });
    await agentAlphaStore.save(brick);

    // Use scope-based promote (zone -> shared)
    const promoteResult = await agentAlphaStore.promote(
      brickId("brick_scope_promote"),
      "zone" as ForgeScope,
    );
    expect(promoteResult.ok).toBe(true);

    // Verify it ended up in the shared tier
    const locate = await agentAlphaStore.locateTier(brickId("brick_scope_promote"));
    expect(locate.ok).toBe(true);
    if (locate.ok) {
      expect(locate.value).toBe("shared");
    }
  });

  // -----------------------------------------------------------------------
  // Test 4: promote_forge tool wires through to store.promote()
  // -----------------------------------------------------------------------

  test("promote_forge tool scope change triggers store.promote()", async () => {
    const { agentAlphaStore } = setup;

    const brick = createToolBrick({
      id: brickId("brick_tool_promote"),
      name: "tool-promoted",
      scope: "agent",
      trustTier: "verified",
      provenance: provenanceFor("alpha"),
    });
    await agentAlphaStore.save(brick);

    // Use the promote_forge tool
    const deps = createDeps(agentAlphaStore, "alpha");
    const promoteTool = createPromoteForgeTool(deps);

    const result = await promoteTool.execute({
      brickId: "brick_tool_promote",
      targetScope: "zone",
    });

    const typed = result as {
      readonly ok: boolean;
      readonly value?: { readonly applied: boolean; readonly changes: Record<string, unknown> };
    };
    expect(typed.ok).toBe(true);
    expect(typed.value?.applied).toBe(true);
    expect(typed.value?.changes.scope).toEqual({ from: "agent", to: "zone" });

    // Verify the brick was physically moved to shared tier
    const locate = await agentAlphaStore.locateTier(brickId("brick_tool_promote"));
    expect(locate.ok).toBe(true);
    if (locate.ok) {
      expect(locate.value).toBe("shared");
    }
  });

  // -----------------------------------------------------------------------
  // Test 5: Both agents can forge + share without conflicts
  // -----------------------------------------------------------------------

  test("both agents forge independently then share without conflict", async () => {
    const { agentAlphaStore, agentBetaStore } = setup;

    // Each agent forges a brick
    const alphaBrick = createToolBrick({
      id: brickId("brick_alpha_1"),
      name: "alpha-tool",
      provenance: provenanceFor("alpha"),
    });
    const betaBrick = createToolBrick({
      id: brickId("brick_beta_1"),
      name: "beta-tool",
      provenance: provenanceFor("beta"),
    });

    await agentAlphaStore.save(alphaBrick);
    await agentBetaStore.save(betaBrick);

    // Each promotes to shared
    const alphaPromote = await agentAlphaStore.promoteTier(brickId("brick_alpha_1"), "shared");
    const betaPromote = await agentBetaStore.promoteTier(brickId("brick_beta_1"), "shared");

    expect(alphaPromote.ok).toBe(true);
    expect(betaPromote.ok).toBe(true);

    // Refresh stores to pick up the new shared bricks
    const alphaRefreshed = await createOverlayForgeStore({
      tiers: [
        {
          name: "agent",
          access: "read-write",
          baseDir: join(setup.sharedDir, "..", "agents", "alpha", "bricks"),
        },
        { name: "shared", access: "read-write", baseDir: setup.sharedDir },
      ],
    });

    // Alpha can see both shared bricks
    const alphaSearch = await alphaRefreshed.search({ kind: "tool" });
    expect(alphaSearch.ok).toBe(true);
    if (alphaSearch.ok) {
      const ids = alphaSearch.value.map((b: BrickArtifact) => b.id);
      expect(ids).toContain(brickId("brick_alpha_1"));
      expect(ids).toContain(brickId("brick_beta_1"));
    }
  });

  // -----------------------------------------------------------------------
  // Test 6: ForgeComponentProvider respects scope filtering
  // -----------------------------------------------------------------------

  test("component provider filters bricks by scope for agent", async () => {
    const { agentAlphaStore } = setup;

    // Save bricks at different scopes
    const agentBrick = createToolBrick({
      id: brickId("brick_agent_scope"),
      name: "agent-only",
      scope: "agent",
    });
    await agentAlphaStore.save(agentBrick);

    // Promote one to shared
    const sharedBrick = createToolBrick({
      id: brickId("brick_shared_scope"),
      name: "shared-tool",
      scope: "zone",
    });
    await agentAlphaStore.save(sharedBrick);

    // Provider with agent scope sees both (agent sees agent + zone + global)
    const agentProvider = createForgeComponentProvider({
      store: agentAlphaStore,
      executor: mockTiered(echoExecutor()),
      scope: "agent",
    });

    const agentComponents = extractMap(
      await agentProvider.attach({
        pid: {
          id: "alpha" as unknown as ReturnType<typeof import("@koi/core").agentId>,
          name: "alpha",
          type: "worker",
          depth: 0,
        },
        manifest: { name: "alpha", version: "0.0.0", model: { name: "test" } },
        state: "running",
        component: () => undefined,
        has: () => false,
        hasAll: () => false,
        query: () => new Map(),
        components: () => new Map(),
      }),
    );
    expect(agentComponents.size).toBe(2);

    // Provider with global scope sees neither (both are narrower than global)
    const globalProvider = createForgeComponentProvider({
      store: agentAlphaStore,
      executor: mockTiered(echoExecutor()),
      scope: "global",
    });

    const globalComponents = extractMap(
      await globalProvider.attach({
        pid: {
          id: "global" as unknown as ReturnType<typeof import("@koi/core").agentId>,
          name: "global",
          type: "worker",
          depth: 0,
        },
        manifest: { name: "global", version: "0.0.0", model: { name: "test" } },
        state: "running",
        component: () => undefined,
        has: () => false,
        hasAll: () => false,
        query: () => new Map(),
        components: () => new Map(),
      }),
    );
    expect(globalComponents.size).toBe(0);
  });
});
