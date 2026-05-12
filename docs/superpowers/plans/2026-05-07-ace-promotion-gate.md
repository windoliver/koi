# ACE Promotion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, evidence-gated structured-playbook promotion engine to `@koi/middleware-ace` for the remaining safe-evolution slice of issue `#1715`.

**Architecture:** Implement the gate as a new `promotion-gate.ts` library surface inside `packages/lib/middleware-ace/src/`. Keep the existing ACE middleware runtime behavior unchanged; the new module owns threshold evaluation, structured-playbook operation application, provenance stamping, and rollback orchestration against existing `StructuredPlaybookStore` and `PlaybookProposalStore` contracts.

**Tech Stack:** TypeScript, Bun test, `@koi/ace-types`, existing ACE in-memory/test helpers, existing SQLite/Nexus ACE storage contracts

---

## File Structure

- `packages/lib/middleware-ace/src/promotion-gate.ts`
  Responsibility: pure decision logic, operation application helpers, and store-backed commit/rollback orchestration.
- `packages/lib/middleware-ace/src/promotion-gate.test.ts`
  Responsibility: TDD coverage for accepted promotion, rejected promotion, rollback, and fail-closed validation paths.
- `packages/lib/middleware-ace/src/index.ts`
  Responsibility: export the new promotion-gate public surface.
- `docs/L2/middleware-ace.md`
  Responsibility: update staged-rollout docs so middleware integration is no longer described as future work and promotion-gate primitives are documented accurately.

### Task 1: Add Threshold Evaluation Surface

**Files:**
- Create: `packages/lib/middleware-ace/src/promotion-gate.test.ts`
- Create: `packages/lib/middleware-ace/src/promotion-gate.ts`
- Modify: `packages/lib/middleware-ace/src/index.ts`

- [ ] **Step 1: Write the failing test for threshold evaluation**

```ts
import { describe, expect, test } from "bun:test";

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PromotionThresholds,
  TrajectoryRange,
} from "@koi/ace-types";

import { evaluatePromotion } from "./promotion-gate.js";

const range: TrajectoryRange = {
  sessionId: "sess-1",
  fromStepIndex: 0,
  toStepIndex: 4,
};

function proposal(): PlaybookProposal {
  return {
    id: "prop-1",
    playbookId: "spb-1",
    baseVersion: 1,
    operations: [{ kind: "add", section: "Errors", content: "Check state before editing." }],
    sourceTrajectoryRange: range,
    reflection: {
      rootCause: "precondition skipped",
      keyInsight: "verify filesystem state first",
      bulletTags: [],
    },
    createdAt: 100,
  };
}

function thresholds(): PromotionThresholds {
  return {
    minHelpfulRate: 0.6,
    maxHarmfulRate: 0.2,
    minTrials: 3,
    maxTokenDelta: 32,
  };
}

describe("evaluatePromotion", () => {
  test("returns promote when verdict and evidence satisfy thresholds", async () => {
    const evaluation: PlaybookEvaluation = {
      id: "eval-1",
      proposalId: "prop-1",
      verdict: "promote",
      metrics: {
        helpfulRate: 0.8,
        harmfulRate: 0.1,
        trials: 4,
        tokenDelta: 12,
      },
      evaluatedAt: 200,
    };

    await expect(evaluatePromotion(proposal(), evaluation, thresholds())).resolves.toBe("promote");
  });

  test("returns reject when required evidence is missing", async () => {
    const evaluation: PlaybookEvaluation = {
      id: "eval-2",
      proposalId: "prop-1",
      verdict: "promote",
      metrics: {
        helpfulRate: 0.8,
        tokenDelta: 12,
      },
      evaluatedAt: 200,
    };

    await expect(evaluatePromotion(proposal(), evaluation, thresholds())).resolves.toBe("reject");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: FAIL with `Cannot find module "./promotion-gate.js"` or missing export `evaluatePromotion`

- [ ] **Step 3: Write the minimal threshold-evaluation implementation**

```ts
import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PromotionThresholds,
} from "@koi/ace-types";

export async function evaluatePromotion(
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
  thresholds: PromotionThresholds,
): Promise<"promote" | "reject" | "rollback"> {
  if (proposal.id.length === 0 || proposal.playbookId.length === 0) {
    throw new Error("ACE promotion gate: proposal identifiers must be non-empty");
  }
  if (evaluation.id.length === 0 || evaluation.proposalId.length === 0) {
    throw new Error("ACE promotion gate: evaluation identifiers must be non-empty");
  }
  if (evaluation.proposalId !== proposal.id) {
    throw new Error("ACE promotion gate: evaluation.proposalId must match proposal.id");
  }
  if (evaluation.verdict === "reject") return "reject";
  if (evaluation.verdict === "rollback") return "rollback";

  const helpfulRate = evaluation.metrics.helpfulRate;
  const harmfulRate = evaluation.metrics.harmfulRate;
  const trials = evaluation.metrics.trials;
  const tokenDelta = evaluation.metrics.tokenDelta;

  if (
    typeof helpfulRate !== "number" ||
    typeof harmfulRate !== "number" ||
    typeof trials !== "number"
  ) {
    return "reject";
  }
  if (helpfulRate < thresholds.minHelpfulRate) return "reject";
  if (harmfulRate > thresholds.maxHarmfulRate) return "reject";
  if (trials < thresholds.minTrials) return "reject";
  if (
    thresholds.maxTokenDelta !== undefined &&
    (typeof tokenDelta !== "number" || tokenDelta > thresholds.maxTokenDelta)
  ) {
    return "reject";
  }
  return "promote";
}
```

Update `packages/lib/middleware-ace/src/index.ts`:

```ts
export {
  evaluatePromotion,
  commitPromotion,
  rollbackPromotion,
} from "./promotion-gate.js";
export type { PromotionDecision, PromotionGateDeps } from "./promotion-gate.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: PASS for the two `evaluatePromotion` tests

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-ace/src/promotion-gate.ts \
  packages/lib/middleware-ace/src/promotion-gate.test.ts \
  packages/lib/middleware-ace/src/index.ts
git commit -m "feat(middleware-ace): add promotion threshold gate"
```

### Task 2: Add Structured-Playbook Operation Application

**Files:**
- Modify: `packages/lib/middleware-ace/src/promotion-gate.test.ts`
- Modify: `packages/lib/middleware-ace/src/promotion-gate.ts`

- [ ] **Step 1: Write the failing tests for add, merge, and prune application**

Append to `packages/lib/middleware-ace/src/promotion-gate.test.ts`:

```ts
import type { PlaybookProposal, StructuredPlaybook } from "@koi/ace-types";

import { applyProposalOperations } from "./promotion-gate.js";

function structuredPlaybook(): StructuredPlaybook {
  return {
    id: "spb-1",
    title: "Filesystem",
    sections: [
      {
        name: "Errors",
        slug: "errors",
        bullets: [
          {
            id: "b1",
            content: "Check file existence.",
            helpful: 2,
            harmful: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "b2",
            content: "Use atomic writes.",
            helpful: 1,
            harmful: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ],
    tags: ["fs"],
    source: "curated",
    createdAt: 1,
    updatedAt: 1,
    sessionCount: 1,
    version: 1,
  };
}

describe("applyProposalOperations", () => {
  test("applies add, merge, and prune in order", () => {
    const proposal: PlaybookProposal = {
      ...proposal(),
      operations: [
        { kind: "add", section: "Errors", content: "Stat before edit." },
        { kind: "merge", bulletIds: ["b1", "b2"], content: "Check existence and use atomic writes." },
        { kind: "prune", bulletId: "b-new-1" },
      ],
    };

    const next = applyProposalOperations(structuredPlaybook(), proposal, 500);
    const section = next.sections[0];

    expect(section?.bullets.map((b) => b.content)).toEqual(["Check existence and use atomic writes."]);
    expect(section?.bullets[0]?.helpful).toBe(3);
    expect(section?.bullets[0]?.harmful).toBe(1);
  });

  test("throws when merge references a missing bullet", () => {
    const proposal: PlaybookProposal = {
      ...proposal(),
      operations: [{ kind: "merge", bulletIds: ["b1", "missing"], content: "bad" }],
    };

    expect(() => applyProposalOperations(structuredPlaybook(), proposal, 500)).toThrow(
      /missing bullet/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: FAIL with missing export `applyProposalOperations`

- [ ] **Step 3: Write the minimal operation-application implementation**

Add to `packages/lib/middleware-ace/src/promotion-gate.ts`:

```ts
import type { PlaybookBullet, PlaybookProposal, StructuredPlaybook } from "@koi/ace-types";

function clonePlaybook(playbook: StructuredPlaybook): StructuredPlaybook {
  return {
    ...playbook,
    sections: playbook.sections.map((section) => ({
      ...section,
      bullets: section.bullets.map((bullet) => ({ ...bullet })),
    })),
  };
}

function findBullet(
  playbook: StructuredPlaybook,
  bulletId: string,
): { sectionIndex: number; bulletIndex: number; bullet: PlaybookBullet } | undefined {
  for (const [sectionIndex, section] of playbook.sections.entries()) {
    for (const [bulletIndex, bullet] of section.bullets.entries()) {
      if (bullet.id === bulletId) return { sectionIndex, bulletIndex, bullet };
    }
  }
  return undefined;
}

export function applyProposalOperations(
  playbook: StructuredPlaybook,
  proposal: PlaybookProposal,
  now: number,
): StructuredPlaybook {
  const next = clonePlaybook(playbook);
  let generated = 0;

  for (const operation of proposal.operations) {
    if (operation.kind === "add") {
      const id = `b-new-${String(++generated)}`;
      const existingSection = next.sections.find((section) => section.name === operation.section);
      const bullet = {
        id,
        content: operation.content,
        helpful: 0,
        harmful: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (existingSection !== undefined) {
        existingSection.bullets = [...existingSection.bullets, bullet];
      } else {
        next.sections = [
          ...next.sections,
          {
            name: operation.section,
            slug: operation.section.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
            bullets: [bullet],
          },
        ];
      }
      continue;
    }

    if (operation.kind === "merge") {
      const first = findBullet(next, operation.bulletIds[0]);
      const second = findBullet(next, operation.bulletIds[1]);
      if (first === undefined || second === undefined) {
        throw new Error("ACE promotion gate: missing bullet for merge");
      }
      next.sections[first.sectionIndex]!.bullets[first.bulletIndex] = {
        ...first.bullet,
        content: operation.content,
        helpful: first.bullet.helpful + second.bullet.helpful,
        harmful: first.bullet.harmful + second.bullet.harmful,
        updatedAt: now,
      };
      next.sections[second.sectionIndex]!.bullets = next.sections[second.sectionIndex]!.bullets.filter(
        (bullet) => bullet.id !== second.bullet.id,
      );
      continue;
    }

    const target = findBullet(next, operation.bulletId);
    if (target === undefined) {
      throw new Error("ACE promotion gate: missing bullet for prune");
    }
    next.sections[target.sectionIndex]!.bullets = next.sections[target.sectionIndex]!.bullets.filter(
      (bullet) => bullet.id !== operation.bulletId,
    );
  }

  return next;
}
```

Also export it from `packages/lib/middleware-ace/src/index.ts`:

```ts
export { applyProposalOperations } from "./promotion-gate.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: PASS for `evaluatePromotion` and `applyProposalOperations` tests

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-ace/src/promotion-gate.ts \
  packages/lib/middleware-ace/src/promotion-gate.test.ts \
  packages/lib/middleware-ace/src/index.ts
git commit -m "feat(middleware-ace): add structured playbook promotion ops"
```

### Task 3: Add Store-Backed Commit And Reject Paths

**Files:**
- Modify: `packages/lib/middleware-ace/src/promotion-gate.test.ts`
- Modify: `packages/lib/middleware-ace/src/promotion-gate.ts`

- [ ] **Step 1: Write the failing tests for accepted promotion and rejected no-op**

Append to `packages/lib/middleware-ace/src/promotion-gate.test.ts`:

```ts
import type {
  PlaybookEvaluation,
  PlaybookProposalStore,
  StructuredPlaybook,
  StructuredPlaybookStore,
} from "@koi/ace-types";

import { commitPromotion } from "./promotion-gate.js";

function createStructuredStore(seed: StructuredPlaybook): StructuredPlaybookStore {
  const versions = new Map<string, Map<number, StructuredPlaybook>>();
  versions.set(seed.id, new Map([[seed.version, seed]]));
  return {
    get: async (id) => {
      const byVersion = versions.get(id);
      if (byVersion === undefined) return undefined;
      const latestVersion = Math.max(...byVersion.keys());
      return byVersion.get(latestVersion);
    },
    list: async () => [await Promise.resolve(seed)],
    save: async (playbook) => {
      const byVersion = versions.get(playbook.id) ?? new Map<number, StructuredPlaybook>();
      byVersion.set(playbook.version, playbook);
      versions.set(playbook.id, byVersion);
    },
    remove: async () => false,
    getVersion: async (id, version) => versions.get(id)?.get(version),
  };
}

function createProposalStore(): PlaybookProposalStore {
  return {
    recordProposal: async () => {},
    recordEvaluation: async () => {},
    getProposal: async () => undefined,
    listProposals: async () => [],
  };
}

describe("commitPromotion", () => {
  test("promotes a structured playbook, increments version, and stamps provenance", async () => {
    const store = createStructuredStore(structuredPlaybook());
    const evaluation: PlaybookEvaluation = {
      id: "eval-1",
      proposalId: "prop-1",
      verdict: "promote",
      metrics: { helpfulRate: 0.8, harmfulRate: 0.1, trials: 4, tokenDelta: 12 },
      evaluatedAt: 200,
    };
    const decision = await commitPromotion(
      { structuredStore: store, proposalStore: createProposalStore(), clock: () => 500 },
      proposal(),
      evaluation,
      thresholds(),
    );

    expect(decision.outcome).toBe("promoted");
    expect(decision.fromVersion).toBe(1);
    expect(decision.toVersion).toBe(2);

    const saved = await store.get("spb-1");
    expect(saved?.version).toBe(2);
    expect(saved?.provenance).toEqual({
      sourceTrajectoryRange: range,
      proposalId: "prop-1",
      evaluationId: "eval-1",
      committedAt: 500,
    });
  });

  test("rejects without mutating the playbook when evidence is insufficient", async () => {
    const store = createStructuredStore(structuredPlaybook());
    const evaluation: PlaybookEvaluation = {
      id: "eval-2",
      proposalId: "prop-1",
      verdict: "promote",
      metrics: { helpfulRate: 0.2, harmfulRate: 0.1, trials: 1, tokenDelta: 12 },
      evaluatedAt: 200,
    };

    const decision = await commitPromotion(
      { structuredStore: store, proposalStore: createProposalStore(), clock: () => 500 },
      proposal(),
      evaluation,
      thresholds(),
    );

    expect(decision.outcome).toBe("rejected");
    expect(decision.fromVersion).toBe(1);
    expect(decision.toVersion).toBe(1);
    expect((await store.get("spb-1"))?.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: FAIL with missing export `commitPromotion` or wrong signature

- [ ] **Step 3: Write the minimal store-backed commit implementation**

Extend `packages/lib/middleware-ace/src/promotion-gate.ts`:

```ts
import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PromotionThresholds,
  StructuredPlaybookStore,
} from "@koi/ace-types";

export interface PromotionGateDeps {
  readonly structuredStore: StructuredPlaybookStore;
  readonly proposalStore?: PlaybookProposalStore;
  readonly clock?: () => number;
}

export interface PromotionDecision {
  readonly outcome: "promoted" | "rejected" | "rolled_back";
  readonly playbookId: string;
  readonly proposalId: string;
  readonly evaluationId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

export async function commitPromotion(
  deps: PromotionGateDeps,
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
  thresholds: PromotionThresholds,
): Promise<PromotionDecision> {
  const current = await deps.structuredStore.get(proposal.playbookId);
  if (current === undefined) {
    throw new Error(`ACE promotion gate: structured playbook not found: ${proposal.playbookId}`);
  }
  if (current.version !== proposal.baseVersion) {
    throw new Error(
      `ACE promotion gate: base version mismatch for ${proposal.playbookId}; expected ${proposal.baseVersion}, got ${current.version}`,
    );
  }

  const decision = await evaluatePromotion(proposal, evaluation, thresholds);
  if (decision !== "promote") {
    if (deps.proposalStore !== undefined) {
      await deps.proposalStore.recordEvaluation(evaluation);
    }
    return {
      outcome: decision === "rollback" ? "rolled_back" : "rejected",
      playbookId: proposal.playbookId,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      fromVersion: current.version,
      toVersion: current.version,
    };
  }

  const now = deps.clock?.() ?? Date.now();
  const nextBody = applyProposalOperations(current, proposal, now);
  const next = {
    ...nextBody,
    updatedAt: now,
    version: current.version + 1,
    provenance: {
      sourceTrajectoryRange: proposal.sourceTrajectoryRange,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      committedAt: now,
    },
  };

  await deps.structuredStore.save(next);
  if (deps.proposalStore !== undefined) {
    await deps.proposalStore.recordEvaluation(evaluation);
  }
  return {
    outcome: "promoted",
    playbookId: proposal.playbookId,
    proposalId: proposal.id,
    evaluationId: evaluation.id,
    fromVersion: current.version,
    toVersion: next.version,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: PASS for accepted promotion and rejected no-op tests

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-ace/src/promotion-gate.ts \
  packages/lib/middleware-ace/src/promotion-gate.test.ts
git commit -m "feat(middleware-ace): add structured playbook promotion commit path"
```

### Task 4: Add Rollback And Documentation

**Files:**
- Modify: `packages/lib/middleware-ace/src/promotion-gate.test.ts`
- Modify: `packages/lib/middleware-ace/src/promotion-gate.ts`
- Modify: `packages/lib/middleware-ace/src/index.ts`
- Modify: `docs/L2/middleware-ace.md`

- [ ] **Step 1: Write the failing rollback and docs-alignment tests**

Append rollback test to `packages/lib/middleware-ace/src/promotion-gate.test.ts`:

```ts
import { rollbackPromotion } from "./promotion-gate.js";

describe("rollbackPromotion", () => {
  test("restores a previous version as a new head", async () => {
    const base = structuredPlaybook();
    const promoted = {
      ...applyProposalOperations(base, proposal(), 500),
      id: base.id,
      title: base.title,
      tags: base.tags,
      source: base.source,
      createdAt: base.createdAt,
      updatedAt: 500,
      sessionCount: base.sessionCount,
      version: 2,
    };

    const versions = new Map<string, Map<number, StructuredPlaybook>>([
      [base.id, new Map([[1, base], [2, promoted]])],
    ]);
    const store: StructuredPlaybookStore = {
      get: async (id) => versions.get(id)?.get(2),
      list: async () => [promoted],
      save: async (playbook) => {
        versions.get(playbook.id)?.set(playbook.version, playbook);
      },
      remove: async () => false,
      getVersion: async (id, version) => versions.get(id)?.get(version),
    };

    const evaluation: PlaybookEvaluation = {
      id: "eval-rb",
      proposalId: "prop-1",
      verdict: "rollback",
      metrics: { helpfulRate: 0.1, harmfulRate: 0.8, trials: 4 },
      evaluatedAt: 900,
    };

    const decision = await rollbackPromotion(
      { structuredStore: store, clock: () => 1000 },
      proposal(),
      1,
      evaluation,
    );

    expect(decision.outcome).toBe("rolled_back");
    expect(decision.fromVersion).toBe(2);
    expect(decision.toVersion).toBe(3);
    expect((await store.get("spb-1"))?.sections).toEqual(base.sections);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: FAIL with missing export `rollbackPromotion`

- [ ] **Step 3: Write rollback orchestration and docs update**

Add to `packages/lib/middleware-ace/src/promotion-gate.ts`:

```ts
export async function rollbackPromotion(
  deps: PromotionGateDeps,
  proposal: PlaybookProposal,
  targetVersion: number,
  evaluation: PlaybookEvaluation,
): Promise<PromotionDecision> {
  const current = await deps.structuredStore.get(proposal.playbookId);
  if (current === undefined) {
    throw new Error(`ACE promotion gate: structured playbook not found: ${proposal.playbookId}`);
  }
  if (deps.structuredStore.getVersion === undefined) {
    throw new Error("ACE promotion gate: rollback requires structuredStore.getVersion");
  }

  const prior = await deps.structuredStore.getVersion(proposal.playbookId, targetVersion);
  if (prior === undefined) {
    throw new Error(
      `ACE promotion gate: rollback target version not found for ${proposal.playbookId}@${targetVersion}`,
    );
  }

  const now = deps.clock?.() ?? Date.now();
  const restored = {
    ...prior,
    version: current.version + 1,
    updatedAt: now,
    provenance: {
      sourceTrajectoryRange: proposal.sourceTrajectoryRange,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      committedAt: now,
    },
  };

  await deps.structuredStore.save(restored);
  if (deps.proposalStore !== undefined) {
    await deps.proposalStore.recordEvaluation(evaluation);
  }
  return {
    outcome: "rolled_back",
    playbookId: proposal.playbookId,
    proposalId: proposal.id,
    evaluationId: evaluation.id,
    fromVersion: current.version,
    toVersion: restored.version,
  };
}
```

Update `docs/L2/middleware-ace.md`:

```md
- This revision already ships middleware integration (`createAceMiddleware`) and
  runtime wiring for the stat pipeline.
- This revision also adds promotion-gate primitives for structured playbooks:
  `evaluatePromotion`, `commitPromotion`, and `rollbackPromotion`.
- Still future work: LLM reflector/curator synthesis, `ace_reflect`, and
  automatic wiring from reflection output into proposal generation.
```

- [ ] **Step 4: Run targeted tests and docs sanity checks**

Run: `bun test packages/lib/middleware-ace/src/promotion-gate.test.ts`
Expected: PASS for rollback and previous promotion tests

Run: `bun test packages/lib/middleware-ace`
Expected: PASS for full package test suite

Run: `bunx biome check packages/lib/middleware-ace/src/promotion-gate.ts packages/lib/middleware-ace/src/promotion-gate.test.ts docs/L2/middleware-ace.md`
Expected: PASS with no formatting or lint errors

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-ace/src/promotion-gate.ts \
  packages/lib/middleware-ace/src/promotion-gate.test.ts \
  packages/lib/middleware-ace/src/index.ts \
  docs/L2/middleware-ace.md
git commit -m "feat(middleware-ace): add ACE promotion rollback primitives"
```

## Self-Review

- Spec coverage:
  - Threshold enforcement: Task 1
  - Reversible operation application: Task 2
  - Provenance-bearing commit path: Task 3
  - Rollback path and lineage requirement: Task 4
  - Docs alignment: Task 4
- Placeholder scan:
  - No `TODO`, `TBD`, or “similar to Task N” placeholders remain.
- Type consistency:
  - Uses existing `PromotionThresholds`, `PlaybookProposal`, `PlaybookEvaluation`, `StructuredPlaybookStore`, and `PlaybookProposalStore` names from `@koi/ace-types`
  - Public signatures match the approved spec except for adding `thresholds` to `commitPromotion`, which is required to keep the orchestration helper self-contained
