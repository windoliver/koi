# Auto-Harness L3 Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live `@koi/auto-harness` L3 package and wire it through runtime and CLI host assembly so demand-driven harness synthesis is verified, policy-gated, and never deployed without explicit approval.

**Architecture:** Introduce a dedicated `packages/meta/auto-harness` composition package that owns the demand -> synthesize -> verify -> policy -> deploy pipeline and exposes a small stack factory. Thread that package into `@koi/runtime` as an optional config-driven subsystem, then let `packages/meta/cli/src/runtime-factory.ts` supply the approval gate and host-facing config without duplicating the composition logic.

**Tech Stack:** TypeScript, Bun test, tsup, `@koi/forge-demand`, `@koi/harness-synth`, `@koi/harness-search`, `@koi/forge-verifier`, `@koi/forge-policy`, `@koi/middleware-policy-cache`, `@koi/runtime`, `@koi-agent/cli`

---

### Task 1: Scaffold `@koi/auto-harness` and lock the public contract

**Files:**
- Create: `packages/meta/auto-harness/package.json`
- Create: `packages/meta/auto-harness/tsconfig.json`
- Create: `packages/meta/auto-harness/tsup.config.ts`
- Create: `packages/meta/auto-harness/src/index.ts`
- Create: `packages/meta/auto-harness/src/types.ts`
- Create: `packages/meta/auto-harness/src/create-auto-harness-stack.ts`
- Create: `packages/meta/auto-harness/src/create-auto-harness-stack.test.ts`
- Modify: `tsconfig.json`
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/cli/package.json`
- Modify: `packages/meta/cli/tsconfig.json`

- [ ] **Step 1: Write the failing package contract test**

```ts
import { describe, expect, test } from "bun:test";
import type { ForgeDemandSignal, StoreChangeNotifier } from "@koi/core";
import { createAutoHarnessStack } from "./create-auto-harness-stack.js";

const makeNotifier = (): StoreChangeNotifier => ({
  notify: () => {},
  subscribe: () => () => {},
});

describe("createAutoHarnessStack", () => {
  test("returns policy-cache middleware, synthesis callback, and session controls", () => {
    const stack = createAutoHarnessStack({
      forgeStore: {
        save: async () => ({ ok: true as const, value: undefined }),
      } as never,
      notifier: makeNotifier(),
      generate: async () => "export function createMiddleware() {}",
      verifyCandidate: async () => ({ ok: true as const, artifact: null }),
      evaluatePolicy: async () => ({ ok: true as const, action: "allow" }),
      requestDeploymentApproval: async () => true,
      deployCandidate: async () => ({ ok: true as const }),
    });

    expect(stack.policyCacheMiddleware.name).toBe("policy-cache");
    expect(typeof stack.synthesizeHarness).toBe("function");
    expect(typeof stack.resetSession).toBe("function");
    expect(stack.maxSynthesesPerSession).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/meta/auto-harness/src/create-auto-harness-stack.test.ts`

Expected: FAIL with module-not-found or missing-export errors for `packages/meta/auto-harness/src/create-auto-harness-stack.ts`.

- [ ] **Step 3: Add the minimal package skeleton and exported types**

```json
{
  "name": "@koi/auto-harness",
  "description": "L3 auto-harness composition for demand-driven middleware synthesis",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "bun ../../../scripts/run-tsup.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/forge-policy": "workspace:*",
    "@koi/forge-verifier": "workspace:*",
    "@koi/harness-search": "workspace:*",
    "@koi/harness-synth": "workspace:*",
    "@koi/hash": "workspace:*",
    "@koi/middleware-policy-cache": "workspace:*"
  }
}
```

```json
// tsconfig.json
{
  "references": [
    { "path": "packages/meta/auto-harness" },
    { "path": "packages/meta/runtime" }
  ]
}
```

```json
// packages/meta/runtime/tsconfig.json and packages/meta/cli/tsconfig.json
{
  "references": [
    { "path": "../auto-harness" }
  ]
}
```

```ts
// packages/meta/auto-harness/src/types.ts
import type { BrickArtifact, ForgeDemandSignal, ForgeStore, KoiMiddleware, StoreChangeNotifier } from "@koi/core";
import type { PolicyCacheHandle } from "@koi/middleware-policy-cache";

export interface AutoHarnessVerificationResult {
  readonly ok: boolean;
  readonly artifact: BrickArtifact | null;
  readonly reason?: string | undefined;
}

export interface AutoHarnessPolicyResult {
  readonly ok: boolean;
  readonly action: "allow" | "block";
  readonly reason?: string | undefined;
}

export interface AutoHarnessDeployResult {
  readonly ok: boolean;
  readonly deployedArtifactId?: string | undefined;
  readonly reason?: string | undefined;
}

export interface AutoHarnessConfig {
  readonly forgeStore: ForgeStore;
  readonly notifier?: StoreChangeNotifier | undefined;
  readonly generate: (prompt: string) => Promise<string>;
  readonly verifyCandidate: (signal: ForgeDemandSignal, code: string) => Promise<AutoHarnessVerificationResult>;
  readonly evaluatePolicy: (artifact: BrickArtifact, signal: ForgeDemandSignal) => Promise<AutoHarnessPolicyResult>;
  readonly requestDeploymentApproval: (artifact: BrickArtifact, signal: ForgeDemandSignal) => Promise<boolean>;
  readonly deployCandidate: (artifact: BrickArtifact, signal: ForgeDemandSignal) => Promise<AutoHarnessDeployResult>;
  readonly maxIterations?: number | undefined;
  readonly maxSynthesesPerSession?: number | undefined;
  readonly enableRefinement?: boolean | undefined;
  readonly onEvent?: ((event: AutoHarnessEvent) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface AutoHarnessStack {
  readonly policyCacheMiddleware: KoiMiddleware;
  readonly policyCacheHandle: PolicyCacheHandle;
  readonly synthesizeHarness: (signal: ForgeDemandSignal) => Promise<BrickArtifact | null>;
  readonly maxSynthesesPerSession: number;
  readonly resetSession: () => void;
}

export type AutoHarnessEvent =
  | { readonly kind: "synthesis.started"; readonly signalId: string }
  | { readonly kind: "verification.failed"; readonly signalId: string; readonly reason: string }
  | { readonly kind: "policy.blocked"; readonly signalId: string; readonly reason: string }
  | { readonly kind: "approval.denied"; readonly signalId: string }
  | { readonly kind: "deployment.succeeded"; readonly signalId: string; readonly artifactId: string };
```

```ts
// packages/meta/auto-harness/src/index.ts
export { createAutoHarnessStack } from "./create-auto-harness-stack.js";
export type {
  AutoHarnessConfig,
  AutoHarnessDeployResult,
  AutoHarnessEvent,
  AutoHarnessPolicyResult,
  AutoHarnessStack,
  AutoHarnessVerificationResult,
} from "./types.js";
```

- [ ] **Step 4: Run the package test to verify the contract passes**

Run: `bun test packages/meta/auto-harness/src/create-auto-harness-stack.test.ts`

Expected: PASS with one green contract test.

- [ ] **Step 5: Commit the scaffold**

```bash
git add tsconfig.json \
  packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json \
  packages/meta/cli/package.json packages/meta/cli/tsconfig.json \
  packages/meta/auto-harness
git commit -m "feat: scaffold auto-harness meta package"
```

### Task 2: Implement the gated auto-harness pipeline inside the new package

**Files:**
- Modify: `packages/meta/auto-harness/src/types.ts`
- Modify: `packages/meta/auto-harness/src/create-auto-harness-stack.ts`
- Modify: `packages/meta/auto-harness/src/create-auto-harness-stack.test.ts`

- [ ] **Step 1: Add failing tests for verification, policy, and approval gates**

```ts
test("halts before deployment when verification fails", async () => {
  let deployed = false;
  const stack = createAutoHarnessStack({
    forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
    generate: async () => "candidate-code",
    verifyCandidate: async () => ({ ok: false, artifact: null, reason: "bad verifier result" }),
    evaluatePolicy: async () => ({ ok: true, action: "allow" }),
    requestDeploymentApproval: async () => true,
    deployCandidate: async () => {
      deployed = true;
      return { ok: true };
    },
  });

  const result = await stack.synthesizeHarness({ id: "sig-1" } as never);
  expect(result).toBeNull();
  expect(deployed).toBe(false);
});

test("halts before deployment when policy blocks", async () => {
  let deployed = false;
  const artifact = { id: "brick-1", kind: "middleware" } as never;
  const stack = createAutoHarnessStack({
    forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
    generate: async () => "candidate-code",
    verifyCandidate: async () => ({ ok: true, artifact }),
    evaluatePolicy: async () => ({ ok: false, action: "block", reason: "policy violation" }),
    requestDeploymentApproval: async () => true,
    deployCandidate: async () => {
      deployed = true;
      return { ok: true };
    },
  });

  const result = await stack.synthesizeHarness({ id: "sig-2" } as never);
  expect(result).toBeNull();
  expect(deployed).toBe(false);
});

test("requires explicit approval before deployment", async () => {
  let deployed = false;
  const artifact = { id: "brick-2", kind: "middleware" } as never;
  const stack = createAutoHarnessStack({
    forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
    generate: async () => "candidate-code",
    verifyCandidate: async () => ({ ok: true, artifact }),
    evaluatePolicy: async () => ({ ok: true, action: "allow" }),
    requestDeploymentApproval: async () => false,
    deployCandidate: async () => {
      deployed = true;
      return { ok: true };
    },
  });

  const result = await stack.synthesizeHarness({ id: "sig-3" } as never);
  expect(result).toBeNull();
  expect(deployed).toBe(false);
});
```

- [ ] **Step 2: Run the package tests to verify they fail for the right reason**

Run: `bun test packages/meta/auto-harness/src/create-auto-harness-stack.test.ts`

Expected: FAIL because `synthesizeHarness()` does not yet enforce the verification, policy, and approval gates.

- [ ] **Step 3: Implement the minimal gated pipeline**

```ts
import type { BrickArtifact, ForgeDemandSignal } from "@koi/core";
import { createPolicyCacheMiddleware } from "@koi/middleware-policy-cache";
import type { AutoHarnessConfig, AutoHarnessStack } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_SYNTHESES = 3;

export function createAutoHarnessStack(config: AutoHarnessConfig): AutoHarnessStack {
  const policyCacheHandle = createPolicyCacheMiddleware({ notifier: config.notifier });
  const synthesized = new Set<string>();
  const maxSynthesesPerSession = config.maxSynthesesPerSession ?? DEFAULT_MAX_SYNTHESES;

  async function synthesizeHarness(signal: ForgeDemandSignal): Promise<BrickArtifact | null> {
    if (synthesized.size >= maxSynthesesPerSession) return null;

    config.onEvent?.({ kind: "synthesis.started", signalId: signal.id });
    const prompt = `Synthesize a harness for signal ${signal.id}`;
    const code = await config.generate(prompt);

    const verification = await config.verifyCandidate(signal, code);
    if (!verification.ok || verification.artifact === null) {
      config.onEvent?.({
        kind: "verification.failed",
        signalId: signal.id,
        reason: verification.reason ?? "verification failed",
      });
      return null;
    }

    const policy = await config.evaluatePolicy(verification.artifact, signal);
    if (!policy.ok || policy.action !== "allow") {
      config.onEvent?.({
        kind: "policy.blocked",
        signalId: signal.id,
        reason: policy.reason ?? "policy blocked candidate",
      });
      return null;
    }

    const approved = await config.requestDeploymentApproval(verification.artifact, signal);
    if (!approved) {
      config.onEvent?.({ kind: "approval.denied", signalId: signal.id });
      return null;
    }

    const deployed = await config.deployCandidate(verification.artifact, signal);
    if (!deployed.ok) return null;

    synthesized.add(signal.id);
    config.onEvent?.({
      kind: "deployment.succeeded",
      signalId: signal.id,
      artifactId: verification.artifact.id,
    });
    return verification.artifact;
  }

  return {
    policyCacheMiddleware: policyCacheHandle.middleware,
    policyCacheHandle,
    synthesizeHarness,
    maxSynthesesPerSession,
    resetSession: () => synthesized.clear(),
  };
}
```

- [ ] **Step 4: Run the package tests to verify the gating behavior passes**

Run: `bun test packages/meta/auto-harness/src/create-auto-harness-stack.test.ts`

Expected: PASS with the contract test plus the three gate tests green.

- [ ] **Step 5: Commit the package behavior**

```bash
git add packages/meta/auto-harness/src
git commit -m "feat: implement gated auto-harness pipeline"
```

### Task 3: Wire auto-harness into `@koi/runtime`

**Files:**
- Create: `packages/meta/runtime/src/__tests__/auto-harness.integration.test.ts`
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/index.ts`
- Modify: `packages/meta/runtime/src/types.ts`
- Modify: `packages/meta/runtime/src/create-runtime.ts`

- [ ] **Step 1: Add failing runtime integration tests**

```ts
import { describe, expect, test } from "bun:test";
import { createRuntime } from "../create-runtime.js";

describe("createRuntime autoHarness wiring", () => {
  test("installs policy-cache middleware when autoHarness is enabled", () => {
    const runtime = createRuntime({
      requestApproval: async () => ({ kind: "allow" }),
      autoHarness: {
        forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
        generate: async () => "candidate-code",
        verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-1" } as never }),
        evaluatePolicy: async () => ({ ok: true, action: "allow" }),
        deployCandidate: async () => ({ ok: true }),
      },
    });

    expect(runtime.middleware.map((mw) => mw.name)).toContain("policy-cache");
    expect(runtime.autoHarness).toBeDefined();
  });

  test("does not deploy when runtime approval denies the request", async () => {
    let deployed = false;
    const runtime = createRuntime({
      requestApproval: async () => ({ kind: "deny", reason: "no" }),
      autoHarness: {
        forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
        generate: async () => "candidate-code",
        verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-2" } as never }),
        evaluatePolicy: async () => ({ ok: true, action: "allow" }),
        deployCandidate: async () => {
          deployed = true;
          return { ok: true };
        },
      },
    });

    const result = await runtime.autoHarness?.synthesizeHarness({ id: "sig-4" } as never);
    expect(result).toBeNull();
    expect(deployed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the runtime integration tests to verify they fail**

Run: `bun test packages/meta/runtime/src/__tests__/auto-harness.integration.test.ts`

Expected: FAIL because `RuntimeConfig` and `RuntimeHandle` do not yet support `autoHarness`.

- [ ] **Step 3: Implement the runtime config and wiring**

```ts
// packages/meta/runtime/src/types.ts
export interface RuntimeAutoHarnessConfig
  extends Omit<import("@koi/auto-harness").AutoHarnessConfig, "requestDeploymentApproval"> {}

export interface RuntimeAutoHarnessHandle {
  readonly middleware: import("@koi/core").KoiMiddleware;
  readonly synthesizeHarness: (signal: import("@koi/core").ForgeDemandSignal) => Promise<import("@koi/core").BrickArtifact | null>;
  readonly resetSession: () => void;
}

export interface RuntimeConfig {
  readonly autoHarness?: RuntimeAutoHarnessConfig | undefined;
}

export interface RuntimeHandle {
  readonly autoHarness?: RuntimeAutoHarnessHandle | undefined;
}
```

```ts
// packages/meta/runtime/src/create-runtime.ts
import { createAutoHarnessStack } from "@koi/auto-harness";

let autoHarnessHandle:
  | ReturnType<typeof createAutoHarnessStack>
  | undefined;

if (config.autoHarness !== undefined) {
  autoHarnessHandle = createAutoHarnessStack({
    ...config.autoHarness,
    requestDeploymentApproval: async () => {
      const decision = await config.requestApproval?.({
        toolId: "auto_harness_deploy",
        input: { subsystem: "auto-harness" },
      });
      return decision?.kind === "allow" || decision?.kind === "always-allow";
    },
  });
}

const baseWithAutoHarness: readonly KoiMiddleware[] =
  autoHarnessHandle !== undefined
    ? [...baseWithForgeDemand, autoHarnessHandle.policyCacheMiddleware]
    : baseWithForgeDemand;
```

```ts
return {
  // existing fields...
  autoHarness:
    autoHarnessHandle !== undefined
      ? {
          middleware: autoHarnessHandle.policyCacheMiddleware,
          synthesizeHarness: autoHarnessHandle.synthesizeHarness,
          resetSession: autoHarnessHandle.resetSession,
        }
      : undefined,
};
```

- [ ] **Step 4: Run the runtime tests to verify the new wiring passes**

Run: `bun test packages/meta/runtime/src/__tests__/auto-harness.integration.test.ts`

Expected: PASS with both runtime wiring tests green.

- [ ] **Step 5: Commit the runtime integration**

```bash
git add packages/meta/runtime
git commit -m "feat: wire auto-harness into runtime"
```

### Task 4: Thread host config through `createKoiRuntime` and verify the full path

**Files:**
- Modify: `packages/meta/cli/package.json`
- Modify: `packages/meta/cli/tsconfig.json`
- Modify: `packages/meta/cli/src/runtime-factory.ts`
- Modify: `packages/meta/cli/src/runtime-factory.test.ts`

- [ ] **Step 1: Add a failing host-integration test in `runtime-factory.test.ts`**

```ts
test("passes autoHarness config through to createRuntime and preserves approval gating", async () => {
  runtimeHandle = await createKoiRuntime({
    ...makeConfig(),
    autoHarness: {
      forgeStore: { save: async () => ({ ok: true as const, value: undefined }) } as never,
      generate: async () => "candidate-code",
      verifyCandidate: async () => ({ ok: true, artifact: { id: "brick-5" } as never }),
      evaluatePolicy: async () => ({ ok: true, action: "allow" }),
      deployCandidate: async () => ({ ok: true }),
    },
  });

  expect(runtimeHandle.autoHarness).toBeDefined();
  expect(typeof runtimeHandle.autoHarness?.synthesizeHarness).toBe("function");
});
```

- [ ] **Step 2: Run the CLI runtime-factory test to verify it fails**

Run: `bun test packages/meta/cli/src/runtime-factory.test.ts`

Expected: FAIL because `KoiRuntimeConfig` does not yet expose `autoHarness`, or because the config is not forwarded into the runtime assembly path.

- [ ] **Step 3: Thread `autoHarness` through the host factory**

```ts
// packages/meta/cli/src/runtime-factory.ts
export interface KoiRuntimeConfig {
  readonly autoHarness?:
    | Omit<import("@koi/auto-harness").AutoHarnessConfig, "requestDeploymentApproval">
    | undefined;
}
```

```ts
const runtimeHandle = createRuntime({
  // existing fields...
  requestApproval: async (request) => config.approvalHandler(request),
  ...(config.autoHarness !== undefined ? { autoHarness: config.autoHarness } : {}),
});
```

```ts
export interface KoiRuntimeHandle {
  readonly runtime: KoiRuntime;
  readonly autoHarness?: import("@koi/runtime").RuntimeAutoHarnessHandle | undefined;
}
```

```ts
return {
  // existing fields...
  runtime: koiRuntime,
  autoHarness: runtimeHandle.autoHarness,
};
```

- [ ] **Step 4: Run the focused verification commands**

Run:

```bash
bun test packages/meta/auto-harness/src/create-auto-harness-stack.test.ts
bun test packages/meta/runtime/src/__tests__/auto-harness.integration.test.ts
bun test packages/meta/cli/src/runtime-factory.test.ts
bun test packages/meta/runtime/src/create-runtime.test.ts
```

Expected: PASS for all four commands, with no new regressions in the runtime assembly smoke tests.

- [ ] **Step 5: Commit the host plumbing**

```bash
git add packages/meta/cli/src/runtime-factory.ts packages/meta/cli/src/runtime-factory.test.ts \
  packages/meta/cli/package.json packages/meta/cli/tsconfig.json
git commit -m "feat: thread auto-harness through cli runtime factory"
```
