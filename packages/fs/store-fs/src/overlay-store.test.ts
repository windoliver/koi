import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArtifact } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_PROVENANCE, runForgeStoreContractTests } from "@koi/test-utils";
import { createFsForgeStore } from "./fs-store.js";
import type { OverlayConfig } from "./overlay-store.js";
import { createOverlayForgeStore, overlayConfigFromHome } from "./overlay-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

async function freshDir(): Promise<string> {
  testCounter += 1;
  const dir = join(tmpdir(), `koi-overlay-test-${Date.now()}-${testCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId(`brick_${Math.random().toString(36).slice(2, 10)}`),
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

/** Create a standard 4-tier config with fresh temp directories. */
async function create4TierConfig(): Promise<{
  config: OverlayConfig;
  tiers: { agent: string; shared: string; extensions: string; bundled: string };
}> {
  const base = await freshDir();
  const tiers = {
    agent: join(base, "agent"),
    shared: join(base, "shared"),
    extensions: join(base, "extensions"),
    bundled: join(base, "bundled"),
  };
  const config: OverlayConfig = {
    tiers: [
      { name: "agent", access: "read-write", baseDir: tiers.agent },
      { name: "shared", access: "read-write", baseDir: tiers.shared },
      { name: "extensions", access: "read-only", baseDir: tiers.extensions },
      { name: "bundled", access: "read-only", baseDir: tiers.bundled },
    ],
  };
  return { config, tiers };
}

/** Pre-seed a brick into a specific tier directory using a standalone FsForgeStore. */
async function seedTier(tierDir: string, brick: ToolArtifact): Promise<void> {
  const store = await createFsForgeStore({ baseDir: tierDir });
  const result = await store.save(brick);
  if (!result.ok) {
    throw new Error(`Failed to seed tier: ${result.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Contract tests — overlay store must satisfy ForgeStore contract
// ---------------------------------------------------------------------------

runForgeStoreContractTests(async () => {
  const { config } = await create4TierConfig();
  return createOverlayForgeStore(config);
});

// ---------------------------------------------------------------------------
// Overlay-specific behavior
// ---------------------------------------------------------------------------

describe("OverlayForgeStore", () => {
  let config: OverlayConfig;
  let tiers: { agent: string; shared: string; extensions: string; bundled: string };

  beforeEach(async () => {
    const setup = await create4TierConfig();
    config = setup.config;
    tiers = setup.tiers;
  });

  // -- load ----------------------------------------------------------------

  describe("load", () => {
    test("returns highest-priority tier brick when duplicates exist", async () => {
      const bundledBrick = createBrick({ id: brickId("brick_dup"), name: "bundled-version" });
      const agentBrick = createBrick({ id: brickId("brick_dup"), name: "agent-version" });

      await seedTier(tiers.bundled, bundledBrick);
      await seedTier(tiers.agent, agentBrick);

      const store = await createOverlayForgeStore(config);
      const result = await store.load(brickId("brick_dup"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("agent-version");
      }
    });

    test("falls through to lower-priority tier", async () => {
      const bundledBrick = createBrick({ id: brickId("brick_lower"), name: "bundled-only" });
      await seedTier(tiers.bundled, bundledBrick);

      const store = await createOverlayForgeStore(config);
      const result = await store.load(brickId("brick_lower"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("bundled-only");
      }
    });

    test("returns NOT_FOUND when brick is in no tier", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.load(brickId("nonexistent"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- save ----------------------------------------------------------------

  describe("save", () => {
    test("writes to agent tier (first writable)", async () => {
      const store = await createOverlayForgeStore(config);
      const brick = createBrick({ id: brickId("brick_save") });

      const result = await store.save(brick);
      expect(result.ok).toBe(true);

      // Verify it's in the agent tier
      const tierResult = await store.locateTier(brickId("brick_save"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("agent");
      }
    });

    test("returns error when no writable tier configured", async () => {
      const readOnlyConfig: OverlayConfig = {
        tiers: [
          { name: "extensions", access: "read-only", baseDir: tiers.extensions },
          { name: "bundled", access: "read-only", baseDir: tiers.bundled },
        ],
      };
      const store = await createOverlayForgeStore(readOnlyConfig);
      const brick = createBrick({ id: brickId("brick_nowrite") });

      const result = await store.save(brick);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PERMISSION");
      }
    });
  });

  // -- search --------------------------------------------------------------

  describe("search", () => {
    test("deduplicates across tiers, highest priority wins", async () => {
      const bundledBrick = createBrick({ id: brickId("brick_dup"), name: "bundled" });
      const agentBrick = createBrick({ id: brickId("brick_dup"), name: "agent" });
      const sharedBrick = createBrick({ id: brickId("brick_shared_only"), name: "shared" });

      await seedTier(tiers.bundled, bundledBrick);
      await seedTier(tiers.agent, agentBrick);
      await seedTier(tiers.shared, sharedBrick);

      const store = await createOverlayForgeStore(config);
      const result = await store.search({});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        const dupBrick = result.value.find((b) => b.id === brickId("brick_dup"));
        expect(dupBrick?.name).toBe("agent");
      }
    });

    test("applies limit after deduplication", async () => {
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_a1") }));
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_a2") }));
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_a3") }));

      const store = await createOverlayForgeStore(config);
      const result = await store.search({ limit: 2 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  // -- remove --------------------------------------------------------------

  describe("remove", () => {
    test("removes brick from writable tier", async () => {
      const store = await createOverlayForgeStore(config);
      const brick = createBrick({ id: brickId("brick_rm") });
      await store.save(brick);

      const result = await store.remove(brickId("brick_rm"));
      expect(result.ok).toBe(true);

      const exists = await store.exists(brickId("brick_rm"));
      expect(exists.ok).toBe(true);
      if (exists.ok) {
        expect(exists.value).toBe(false);
      }
    });

    test("returns PERMISSION error for brick in read-only tier", async () => {
      await seedTier(tiers.bundled, createBrick({ id: brickId("brick_bundled_rm") }));

      const store = await createOverlayForgeStore(config);
      const result = await store.remove(brickId("brick_bundled_rm"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PERMISSION");
        expect(result.error.message).toContain("read-only");
      }
    });

    test("returns NOT_FOUND for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.remove(brickId("nonexistent"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- update --------------------------------------------------------------

  describe("update", () => {
    test("updates brick in writable tier in place", async () => {
      const store = await createOverlayForgeStore(config);
      await store.save(createBrick({ id: brickId("brick_upd"), usageCount: 0 }));

      const result = await store.update(brickId("brick_upd"), { usageCount: 5 });
      expect(result.ok).toBe(true);

      const loaded = await store.load(brickId("brick_upd"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.usageCount).toBe(5);
      }
    });

    test("auto-promotes from read-only tier before updating", async () => {
      await seedTier(
        tiers.bundled,
        createBrick({ id: brickId("brick_autopromote"), usageCount: 0 }),
      );

      const store = await createOverlayForgeStore(config);
      const result = await store.update(brickId("brick_autopromote"), { usageCount: 10 });
      expect(result.ok).toBe(true);

      // Should now be in agent tier (auto-promoted)
      const tierResult = await store.locateTier(brickId("brick_autopromote"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("agent");
      }

      const loaded = await store.load(brickId("brick_autopromote"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.usageCount).toBe(10);
      }
    });

    test("returns NOT_FOUND for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.update(brickId("nonexistent"), { usageCount: 1 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- exists --------------------------------------------------------------

  describe("exists", () => {
    test("finds brick in any tier", async () => {
      await seedTier(tiers.bundled, createBrick({ id: brickId("brick_exists_bundled") }));
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_exists_agent") }));

      const store = await createOverlayForgeStore(config);

      const r1 = await store.exists(brickId("brick_exists_bundled"));
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.value).toBe(true);

      const r2 = await store.exists(brickId("brick_exists_agent"));
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.value).toBe(true);
    });

    test("returns false for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.exists(brickId("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);
    });
  });

  // -- promoteTier (low-level tier-based promote) ---------------------------

  describe("promoteTier", () => {
    test("moves brick from shared to agent tier", async () => {
      await seedTier(
        tiers.shared,
        createBrick({ id: brickId("brick_promote"), name: "shared-brick" }),
      );

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("brick_promote"), "agent");
      expect(result.ok).toBe(true);

      // Should be in agent tier now
      const tierResult = await store.locateTier(brickId("brick_promote"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("agent");
      }

      // Data preserved
      const loaded = await store.load(brickId("brick_promote"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.name).toBe("shared-brick");
      }
    });

    test("copies brick from read-only tier (source not deleted)", async () => {
      await seedTier(tiers.bundled, createBrick({ id: brickId("brick_promote_ro") }));

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("brick_promote_ro"), "agent");
      expect(result.ok).toBe(true);

      // Now in agent tier
      const tierResult = await store.locateTier(brickId("brick_promote_ro"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("agent");
      }

      // Bundled copy still exists (read-only, not deleted)
      const bundledStore = await createFsForgeStore({ baseDir: tiers.bundled });
      const bundledResult = await bundledStore.exists(brickId("brick_promote_ro"));
      expect(bundledResult.ok).toBe(true);
      if (bundledResult.ok) {
        expect(bundledResult.value).toBe(true);
      }
    });

    test("no-op when brick is already in target tier", async () => {
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_noop") }));

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("brick_noop"), "agent");
      expect(result.ok).toBe(true);
    });

    test("returns PERMISSION error for read-only target tier", async () => {
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_bad_target") }));

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("brick_bad_target"), "bundled");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PERMISSION");
      }
    });

    test("returns NOT_FOUND for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("nonexistent"), "agent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("returns VALIDATION error for unknown tier", async () => {
      const store = await createOverlayForgeStore(config);
      // @ts-expect-error — intentionally passing invalid tier name
      const result = await store.promoteTier(brickId("brick_x"), "nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("idempotent when brick already exists in target with same id", async () => {
      const brick = createBrick({ id: brickId("brick_idemp") });
      await seedTier(tiers.shared, brick);
      await seedTier(tiers.agent, brick);

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("brick_idemp"), "agent");
      expect(result.ok).toBe(true);
    });

    test("idempotent when brick exists in both source and target (same ID)", async () => {
      // Same ID in both tiers — content-addressed, so same ID = same content
      const sourceBrick = createBrick({ id: brickId("brick_both_tiers"), name: "same" });
      const targetBrick = createBrick({ id: brickId("brick_both_tiers"), name: "same" });
      await seedTier(tiers.agent, sourceBrick);
      await seedTier(tiers.shared, targetBrick);

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteTier(brickId("brick_both_tiers"), "shared");
      expect(result.ok).toBe(true);
    });
  });

  // -- promote (scope-based) ------------------------------------------------

  describe("promote (scope-based)", () => {
    test("promotes agent-scoped brick to zone (shared tier)", async () => {
      const brick = createBrick({ id: brickId("brick_scope_zone") });
      await seedTier(tiers.agent, brick);

      const store = await createOverlayForgeStore(config);
      const result = await store.promote(brickId("brick_scope_zone"), "zone");
      expect(result.ok).toBe(true);

      // Should now be in the shared tier
      const tierResult = await store.locateTier(brickId("brick_scope_zone"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("shared");
      }
    });

    test("promotes agent-scoped brick to global (shared tier, since bundled is read-only)", async () => {
      const brick = createBrick({ id: brickId("brick_scope_global") });
      await seedTier(tiers.agent, brick);

      const store = await createOverlayForgeStore(config);
      const result = await store.promote(brickId("brick_scope_global"), "global");
      expect(result.ok).toBe(true);

      // Should be in the shared tier (bundled is read-only, so global routes to shared)
      const tierResult = await store.locateTier(brickId("brick_scope_global"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("shared");
      }
    });

    test("no-op when brick is already at agent scope in agent tier", async () => {
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_scope_noop") }));

      const store = await createOverlayForgeStore(config);
      const result = await store.promote(brickId("brick_scope_noop"), "agent");
      expect(result.ok).toBe(true);
    });

    test("returns NOT_FOUND for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.promote(brickId("nonexistent"), "zone");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- locateTier ----------------------------------------------------------

  describe("locateTier", () => {
    test("returns correct tier name for each tier", async () => {
      await seedTier(tiers.agent, createBrick({ id: brickId("brick_in_agent") }));
      await seedTier(tiers.shared, createBrick({ id: brickId("brick_in_shared") }));
      await seedTier(tiers.extensions, createBrick({ id: brickId("brick_in_ext") }));
      await seedTier(tiers.bundled, createBrick({ id: brickId("brick_in_bundled") }));

      const store = await createOverlayForgeStore(config);

      const r1 = await store.locateTier(brickId("brick_in_agent"));
      expect(r1.ok && r1.value).toBe("agent");

      const r2 = await store.locateTier(brickId("brick_in_shared"));
      expect(r2.ok && r2.value).toBe("shared");

      const r3 = await store.locateTier(brickId("brick_in_ext"));
      expect(r3.ok && r3.value).toBe("extensions");

      const r4 = await store.locateTier(brickId("brick_in_bundled"));
      expect(r4.ok && r4.value).toBe("bundled");
    });

    test("returns NOT_FOUND for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.locateTier(brickId("nonexistent"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- promoteAndUpdate (atomic scope + metadata) ----------------------------

  describe("promoteAndUpdate", () => {
    test("moves brick to target tier with metadata updated in single operation", async () => {
      const brick = createBrick({
        id: brickId("brick_atomic"),
        scope: "agent",
        origin: "primordial",
        policy: DEFAULT_SANDBOXED_POLICY,
        lifecycle: "draft",
        tags: ["old"],
      });
      await seedTier(tiers.agent, brick);

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteAndUpdate(brickId("brick_atomic"), "zone", {
        policy: DEFAULT_UNSANDBOXED_POLICY,
        lifecycle: "active",
        tags: ["new", "zone:team-1"],
      });
      expect(result.ok).toBe(true);

      // Should be in shared tier now (zone → shared)
      const tierResult = await store.locateTier(brickId("brick_atomic"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("shared");
      }

      // Metadata should be updated atomically
      const loaded = await store.load(brickId("brick_atomic"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.scope).toBe("zone");
        expect(loaded.value.policy.sandbox).toBe(false);
        expect(loaded.value.lifecycle).toBe("active");
        expect(loaded.value.tags).toEqual(["new", "zone:team-1"]);
      }
    });

    test("applies metadata update only when brick is already in target tier", async () => {
      const brick = createBrick({
        id: brickId("brick_same_tier"),
        scope: "agent",
        origin: "primordial",
        policy: DEFAULT_SANDBOXED_POLICY,
      });
      await seedTier(tiers.agent, brick);

      const store = await createOverlayForgeStore(config);
      // Promote to agent scope (already in agent tier)
      const result = await store.promoteAndUpdate(brickId("brick_same_tier"), "agent", {
        policy: DEFAULT_UNSANDBOXED_POLICY,
      });
      expect(result.ok).toBe(true);

      // Still in agent tier
      const tierResult = await store.locateTier(brickId("brick_same_tier"));
      expect(tierResult.ok).toBe(true);
      if (tierResult.ok) {
        expect(tierResult.value).toBe("agent");
      }

      // Metadata updated
      const loaded = await store.load(brickId("brick_same_tier"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.policy.sandbox).toBe(false);
      }
    });

    test("returns ok when source removal fails (non-fatal orphan)", async () => {
      // Seed in shared tier, promote to agent tier — source removal is non-fatal
      const brick = createBrick({
        id: brickId("brick_orphan"),
        scope: "zone",
        origin: "primordial",
        policy: DEFAULT_SANDBOXED_POLICY,
      });
      await seedTier(tiers.shared, brick);

      const store = await createOverlayForgeStore(config);
      const result = await store.promoteAndUpdate(brickId("brick_orphan"), "agent", {
        policy: DEFAULT_UNSANDBOXED_POLICY,
      });

      // Should succeed regardless of source removal outcome
      expect(result.ok).toBe(true);

      // Brick should be loadable from agent tier with updated metadata
      const loaded = await store.load(brickId("brick_orphan"));
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.scope).toBe("agent");
        expect(loaded.value.policy.sandbox).toBe(false);
      }
    });

    test("returns NOT_FOUND for nonexistent brick", async () => {
      const store = await createOverlayForgeStore(config);
      const result = await store.promoteAndUpdate(brickId("nonexistent"), "zone", {
        policy: DEFAULT_UNSANDBOXED_POLICY,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // -- dispose ---------------------------------------------------------------

  describe("dispose", () => {
    test("propagates to all tier stores without error", async () => {
      const store = await createOverlayForgeStore(config);

      // Save a brick to exercise a tier store
      const brick = createBrick({ id: brickId("brick_dispose_test") });
      await store.save(brick);

      // Dispose should not throw
      expect(() => store.dispose()).not.toThrow();

      // Double dispose should also not throw
      expect(() => store.dispose()).not.toThrow();
    });
  });

  // -- overlayConfigFromHome -----------------------------------------------

  describe("overlayConfigFromHome", () => {
    test("generates correct tier paths", () => {
      const cfg = overlayConfigFromHome("/home/koi", "my-agent");

      expect(cfg.tiers).toHaveLength(4);
      expect(cfg.tiers[0]).toEqual({
        name: "agent",
        access: "read-write",
        baseDir: join("/home/koi", "agents", "my-agent", "bricks"),
      });
      expect(cfg.tiers[1]).toEqual({
        name: "shared",
        access: "read-write",
        baseDir: join("/home/koi", "shared", "bricks"),
      });
      expect(cfg.tiers[2]).toEqual({
        name: "extensions",
        access: "read-only",
        baseDir: join("/home/koi", "extensions", "bricks"),
      });
      expect(cfg.tiers[3]).toEqual({
        name: "bundled",
        access: "read-only",
        baseDir: join("/home/koi", "bundled", "bricks"),
      });
    });
  });
});
