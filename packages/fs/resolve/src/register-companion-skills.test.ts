/**
 * Tests for companion skill auto-registration into ForgeStore.
 */

import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  BrickId,
  BrickUpdate,
  ForgeQuery,
  ForgeScope,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";

import {
  createCompanionSkillArtifact,
  registerCompanionSkills,
} from "./register-companion-skills.js";
import type { BrickDescriptor, ResolveKind } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory mock ForgeStore
// ---------------------------------------------------------------------------

function createMockForgeStore(opts?: {
  readonly saveShouldFail?: (brick: BrickArtifact) => boolean;
}): ForgeStore & { readonly saved: ReadonlyMap<BrickId, BrickArtifact> } {
  const store = new Map<BrickId, BrickArtifact>();

  const forgeStore: ForgeStore & { readonly saved: ReadonlyMap<BrickId, BrickArtifact> } = {
    get saved(): ReadonlyMap<BrickId, BrickArtifact> {
      return store;
    },

    save: async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
      if (opts?.saveShouldFail?.(brick)) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Simulated save failure for ${brick.name}`,
            retryable: false,
          },
        };
      }
      store.set(brick.id, brick);
      return { ok: true, value: undefined };
    },

    exists: async (id: BrickId): Promise<Result<boolean, KoiError>> => {
      return { ok: true, value: store.has(id) };
    },

    load: async (_id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      throw new Error("not implemented");
    },

    search: async (_query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
      throw new Error("not implemented");
    },

    remove: async (_id: BrickId): Promise<Result<void, KoiError>> => {
      throw new Error("not implemented");
    },

    update: async (_id: BrickId, _updates: BrickUpdate): Promise<Result<void, KoiError>> => {
      throw new Error("not implemented");
    },

    promote: async (_id: BrickId, _scope: ForgeScope): Promise<Result<void, KoiError>> => {
      throw new Error("not implemented");
    },
  };

  return forgeStore;
}

// ---------------------------------------------------------------------------
// Descriptor helper
// ---------------------------------------------------------------------------

function makeDescriptor(
  name: string,
  kind: ResolveKind,
  companionSkills?: BrickDescriptor<unknown>["companionSkills"],
): BrickDescriptor<unknown> {
  const base: BrickDescriptor<unknown> = {
    kind,
    name,
    optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
    factory: () => ({}),
  };
  // exactOptionalPropertyTypes: only include when defined
  if (companionSkills !== undefined) {
    return { ...base, companionSkills };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCompanionSkillArtifact", () => {
  test("creates a valid SkillArtifact from a CompanionSkillDefinition", () => {
    const skill = {
      name: "when-to-use-soul",
      description: "Explains when to use the soul middleware",
      content: "Use soul middleware when you need persistent memory.",
      tags: ["memory"],
    } as const;

    const artifact = createCompanionSkillArtifact(skill, "@koi/soul", "middleware");

    expect(artifact.kind).toBe("skill");
    expect(artifact.name).toBe("when-to-use-soul");
    expect(artifact.description).toBe("Explains when to use the soul middleware");
    expect(artifact.content).toBe("Use soul middleware when you need persistent memory.");
    expect(artifact.scope).toBe("global");
    expect(artifact.policy.sandbox).toBe(false);
    expect(artifact.lifecycle).toBe("active");
    expect(artifact.version).toBe("0.1.0");
    expect(artifact.usageCount).toBe(0);
    expect(artifact.tags).toEqual(["memory", "from:@koi/soul", "companion"]);
    expect(artifact.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.provenance.source).toEqual({
      origin: "bundled",
      bundleName: "@koi/soul",
      bundleVersion: "0.1.0",
    });
    expect(artifact.provenance.classification).toBe("public");
    expect(artifact.provenance.contentMarkers).toEqual([]);
  });
});

describe("registerCompanionSkills", () => {
  test("registers companion skills from descriptors", async () => {
    const store = createMockForgeStore();
    const descriptors = [
      makeDescriptor("@koi/soul", "middleware", [
        { name: "skill-a", description: "Skill A", content: "Content A" },
        { name: "skill-b", description: "Skill B", content: "Content B", tags: ["tag-b"] },
      ]),
    ];

    const result = await registerCompanionSkills(descriptors, store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registered).toBe(2);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toEqual([]);
    expect(store.saved.size).toBe(2);
  });

  test("is idempotent on re-registration", async () => {
    const store = createMockForgeStore();
    const descriptors = [
      makeDescriptor("@koi/soul", "middleware", [
        { name: "skill-a", description: "Skill A", content: "Content A" },
        { name: "skill-b", description: "Skill B", content: "Content B" },
      ]),
    ];

    // First call — registers both
    const first = await registerCompanionSkills(descriptors, store);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.registered).toBe(2);

    // Second call — skips both
    const second = await registerCompanionSkills(descriptors, store);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.registered).toBe(0);
    expect(second.value.skipped).toBe(2);
    expect(store.saved.size).toBe(2);
  });

  test("skips descriptors without companionSkills", async () => {
    const store = createMockForgeStore();
    const descriptors = [makeDescriptor("@koi/plain", "middleware")];

    const result = await registerCompanionSkills(descriptors, store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registered).toBe(0);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toEqual([]);
    expect(store.saved.size).toBe(0);
  });

  test("tolerates save failures and continues", async () => {
    // let is justified: counter for conditional failure
    let callCount = 0;
    const store = createMockForgeStore({
      saveShouldFail: () => {
        callCount += 1;
        return callCount === 1; // fail only the first save
      },
    });

    const descriptors = [
      makeDescriptor("@koi/soul", "middleware", [
        { name: "skill-fail", description: "Will fail", content: "Fail content" },
        { name: "skill-ok", description: "Will succeed", content: "Ok content" },
      ]),
    ];

    const result = await registerCompanionSkills(descriptors, store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registered).toBe(1);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain("skill-fail");
    expect(store.saved.size).toBe(1);
  });

  test("handles empty companionSkills array", async () => {
    const store = createMockForgeStore();
    const descriptors = [makeDescriptor("@koi/empty", "middleware", [])];

    const result = await registerCompanionSkills(descriptors, store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.registered).toBe(0);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toEqual([]);
    expect(store.saved.size).toBe(0);
  });
});
