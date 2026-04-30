# @koi/middleware-intent-capsule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@koi/middleware-intent-capsule`, an L2 KoiMiddleware that cryptographically binds an agent's mandate at session start (Ed25519) and verifies it before every model call, defending against OWASP ASI01 goal hijacking.

**Architecture:** Port v1 (`archive/v1/packages/security/middleware-intent-capsule/`) with `node:crypto` replacing `@koi/crypto-utils` and `computeStringHash` from `@koi/hash` replacing `sha256Hex`. Default verifier does hash comparison only (no asymmetric crypto on hot path). Signing is internal — no `MandateSigner` abstraction.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `node:crypto` (Ed25519), `@koi/hash` (SHA-256), `@koi/core/intent-capsule` (L0 types), `@koi/errors` (KoiRuntimeError), bun:test

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/security/middleware-intent-capsule/package.json` | Create | Package metadata + deps |
| `packages/security/middleware-intent-capsule/tsconfig.json` | Create | TS project config |
| `packages/security/middleware-intent-capsule/tsup.config.ts` | Create | Build config |
| `packages/security/middleware-intent-capsule/src/canonicalize.ts` | Create | Deterministic mandate payload serialization |
| `packages/security/middleware-intent-capsule/src/canonicalize.test.ts` | Create | Unit tests for canonicalization |
| `packages/security/middleware-intent-capsule/src/config.ts` | Create | IntentCapsuleConfig type + resolveConfig + default verifier |
| `packages/security/middleware-intent-capsule/src/middleware.ts` | Create | createIntentCapsuleMiddleware factory + helpers |
| `packages/security/middleware-intent-capsule/src/middleware.test.ts` | Create | All 13 middleware tests |
| `packages/security/middleware-intent-capsule/src/index.ts` | Create | Public re-exports |
| `scripts/layers.ts` | Modify | Add `@koi/middleware-intent-capsule` to L2_PACKAGES |
| `packages/meta/runtime/package.json` | Modify | Add `@koi/middleware-intent-capsule` dep |
| `packages/meta/runtime/tsconfig.json` | Modify | Add `../../security/middleware-intent-capsule` reference |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | Modify | Add 2 per-L2 golden assertions |
| `docs/L2/middleware-intent-capsule.md` | Modify | Replace `@koi/crypto-utils` references with `node:crypto` + `@koi/hash` |
| `docs/L3/runtime.md` | Modify | Add wiring entry for `@koi/middleware-intent-capsule` |

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/security/middleware-intent-capsule/package.json`
- Create: `packages/security/middleware-intent-capsule/tsconfig.json`
- Create: `packages/security/middleware-intent-capsule/tsup.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@koi/middleware-intent-capsule",
  "description": "Cryptographic mandate binding middleware — Ed25519 session signing for OWASP ASI01 goal-hijack defense",
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
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test",
    "test:api": "bun test src/__tests__/api-surface.test.ts"
  },
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*",
    "@koi/hash": "workspace:*"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../../lib/errors" },
    { "path": "../../lib/hash" }
  ]
}
```

- [ ] **Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 4: Install workspace deps**

```bash
bun install
```

Expected: lockfile updated, no errors.

- [ ] **Step 5: Commit scaffold**

```bash
git add packages/security/middleware-intent-capsule/
git commit -m "chore: scaffold @koi/middleware-intent-capsule package"
```

---

## Task 2: canonicalize.ts — TDD

**Files:**
- Create: `packages/security/middleware-intent-capsule/src/canonicalize.ts`
- Create: `packages/security/middleware-intent-capsule/src/canonicalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/security/middleware-intent-capsule/src/canonicalize.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { canonicalizeMandatePayload } from "./canonicalize.js";

describe("canonicalizeMandatePayload", () => {
  it("produces deterministic output for known inputs", () => {
    const result = canonicalizeMandatePayload({
      agentId: "agent-1",
      sessionId: "sess-42",
      systemPrompt: "You are a coding assistant.",
      objectives: ["answer questions", "write tests"],
    });
    expect(result).toBe(
      "v1\nagentId:agent-1\nsessionId:sess-42\nsystemPrompt:You are a coding assistant.\nobjectives:answer questions\nwrite tests",
    );
  });

  it("sorts objectives lexicographically before joining", () => {
    const a = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: ["write tests", "answer questions"],
    });
    const b = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: ["answer questions", "write tests"],
    });
    expect(a).toBe(b);
  });

  it("handles empty objectives", () => {
    const result = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: [],
    });
    expect(result).toBe("v1\nagentId:a\nsessionId:s\nsystemPrompt:p\nobjectives:");
  });

  it("different systemPrompt produces different payload", () => {
    const a = canonicalizeMandatePayload({ agentId: "a", sessionId: "s", systemPrompt: "mission A", objectives: [] });
    const b = canonicalizeMandatePayload({ agentId: "a", sessionId: "s", systemPrompt: "mission B", objectives: [] });
    expect(a).not.toBe(b);
  });

  it("different sessionId produces different payload", () => {
    const a = canonicalizeMandatePayload({ agentId: "a", sessionId: "s1", systemPrompt: "p", objectives: [] });
    const b = canonicalizeMandatePayload({ agentId: "a", sessionId: "s2", systemPrompt: "p", objectives: [] });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/security/middleware-intent-capsule/src/canonicalize.test.ts
```

Expected: FAIL — `Cannot find module './canonicalize.js'`

- [ ] **Step 3: Implement canonicalize.ts**

Create `packages/security/middleware-intent-capsule/src/canonicalize.ts`:

```typescript
/** Inputs that define the agent's mandate for a given session. */
export interface MandateFields {
  readonly agentId: string;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly objectives: readonly string[];
}

/**
 * Builds the canonical string representation of the mandate fields.
 * This string is the SHA-256 input for mandateHash computation.
 *
 * Format (v1):
 *   v1\nagentId:{agentId}\nsessionId:{sessionId}\nsystemPrompt:{systemPrompt}\nobjectives:{sorted-join}
 *
 * Objectives are sorted lexicographically before joining — order-invariant.
 * The "v1" prefix enables future format evolution without ambiguity.
 */
export function canonicalizeMandatePayload(fields: MandateFields): string {
  const sortedObjectives = [...fields.objectives].sort().join("\n");
  return [
    "v1",
    `agentId:${fields.agentId}`,
    `sessionId:${fields.sessionId}`,
    `systemPrompt:${fields.systemPrompt}`,
    `objectives:${sortedObjectives}`,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/security/middleware-intent-capsule/src/canonicalize.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/middleware-intent-capsule/src/
git commit -m "feat(middleware-intent-capsule): canonicalizeMandatePayload"
```

---

## Task 3: config.ts

**Files:**
- Create: `packages/security/middleware-intent-capsule/src/config.ts`

No separate test file — `resolveConfig` and `defaultVerifier` are exercised via middleware tests in Task 4–6.

- [ ] **Step 1: Create config.ts**

```typescript
import type { CapsuleVerifier } from "@koi/core/intent-capsule";

/** Configuration for createIntentCapsuleMiddleware. */
export interface IntentCapsuleConfig {
  /** The agent's system prompt — hashed and signed at session start. */
  readonly systemPrompt: string;
  /**
   * Declared objectives for this agent session. Sorted before hashing.
   * Default: []
   */
  readonly objectives?: readonly string[];
  /**
   * Maximum age for capsule entries before TTL eviction (ms).
   * Eviction runs on every onSessionStart call.
   * Default: 3_600_000 (1 hour)
   */
  readonly maxTtlMs?: number;
  /**
   * When true, the signed mandate is injected as a system message at the
   * start of every model call. Default: false.
   */
  readonly injectMandate?: boolean;
  /**
   * Injectable CapsuleVerifier for testing.
   * Default: hash-comparison-only verifier (no asymmetric crypto on hot path).
   */
  readonly verifier?: CapsuleVerifier;
}

/** Default TTL for capsule session entries — 1 hour. */
export const DEFAULT_CAPSULE_TTL_MS = 3_600_000;

/** Resolve config with defaults applied. */
export function resolveConfig(config: IntentCapsuleConfig): Required<IntentCapsuleConfig> {
  return {
    systemPrompt: config.systemPrompt,
    objectives: config.objectives ?? [],
    maxTtlMs: config.maxTtlMs ?? DEFAULT_CAPSULE_TTL_MS,
    injectMandate: config.injectMandate ?? false,
    verifier: config.verifier ?? defaultVerifier,
  };
}

/** Default verifier: mandate hash equality only. No asymmetric crypto on hot path. */
const defaultVerifier: CapsuleVerifier = {
  verify(capsule, currentMandateHash) {
    if (capsule.mandateHash !== currentMandateHash) {
      return { ok: false, reason: "mandate_hash_mismatch" };
    }
    return { ok: true, capsule };
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/security/middleware-intent-capsule/src/config.ts
git commit -m "feat(middleware-intent-capsule): IntentCapsuleConfig + resolveConfig"
```

---

## Task 4: middleware.ts — happy path TDD

**Files:**
- Create: `packages/security/middleware-intent-capsule/src/middleware.ts`
- Create: `packages/security/middleware-intent-capsule/src/middleware.test.ts` (partial — happy path only)

- [ ] **Step 1: Write failing happy-path tests**

Create `packages/security/middleware-intent-capsule/src/middleware.test.ts`:

```typescript
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SessionContext, TurnContext, ModelRequest, ModelResponse, ModelChunk } from "@koi/core/middleware";
import { sessionId } from "@koi/core";
import { createIntentCapsuleMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSessionCtx(id = "session-abc"): SessionContext {
  return {
    agentId: "agent-test-1",
    sessionId: sessionId(id),
    runId: "run-1" as never,
    metadata: {},
  };
}

function makeTurnCtx(ctx: SessionContext): TurnContext {
  return {
    session: ctx,
    turnIndex: 0,
    turnId: "turn-1" as never,
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "Hello" }],
      },
    ],
  };
}

const mockResponse: ModelResponse = { content: "OK", model: "test-model" };
const nextFn = mock(async (_req: ModelRequest): Promise<ModelResponse> => mockResponse);

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path", () => {
  beforeEach(() => nextFn.mockClear());

  it("creates capsule at onSessionStart and passes wrapModelCall", async () => {
    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "You are a test agent.",
      objectives: ["Answer questions"],
    });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    const response = await mw.wrapModelCall?.(turn, makeModelRequest(), nextFn);
    expect(response?.content).toBe("OK");
    expect(nextFn).toHaveBeenCalledTimes(1);
  });

  it("passes when objectives are empty", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Minimal agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);
    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).resolves.toBeDefined();
  });

  it("passes across multiple sequential turns", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Sequential turns agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    for (let i = 0; i < 3; i++) {
      const turn = { ...makeTurnCtx(ctx), turnIndex: i };
      await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).resolves.toBeDefined();
    }
    expect(nextFn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test packages/security/middleware-intent-capsule/src/middleware.test.ts
```

Expected: FAIL — `Cannot find module './middleware.js'`

- [ ] **Step 3: Implement middleware.ts (happy path)**

Create `packages/security/middleware-intent-capsule/src/middleware.ts`:

```typescript
import { generateKeyPairSync, sign } from "node:crypto";
import type { CapsuleVerifier, IntentCapsule } from "@koi/core/intent-capsule";
import { capsuleId } from "@koi/core/intent-capsule";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { computeStringHash } from "@koi/hash";
import { canonicalizeMandatePayload } from "./canonicalize.js";
import { type IntentCapsuleConfig, resolveConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface CapsuleEntry {
  readonly capsule: IntentCapsule;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function createIntentCapsuleMiddleware(config: IntentCapsuleConfig): KoiMiddleware {
  const resolved = resolveConfig(config);
  const sessions = new Map<string, CapsuleEntry>();

  return {
    name: "intent-capsule",
    priority: 290,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: "intent-capsule",
        description: "Mandate cryptographically bound (Ed25519)",
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      evictStaleSessions(sessions, resolved.maxTtlMs);

      const mandatePayload = canonicalizeMandatePayload({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId as string,
        systemPrompt: resolved.systemPrompt,
        objectives: resolved.objectives,
      });

      const mandateHash = computeStringHash(mandatePayload);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = sign(null, Buffer.from(mandateHash), privateKey).toString("base64");
      const publicKeyB64 = Buffer.from(
        publicKey.export({ format: "der", type: "spki" }),
      ).toString("base64");
      const now = Date.now();

      const capsule: IntentCapsule = {
        id: capsuleId(`${ctx.agentId}:${ctx.sessionId as string}:${now}`),
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        mandateHash,
        signature,
        publicKey: publicKeyB64,
        createdAt: now,
        version: 1,
      };

      sessions.set(ctx.sessionId as string, { capsule, createdAt: now });
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      await verifyCapsule(ctx, resolved, sessions);
      const enriched = resolved.injectMandate
        ? injectMandateMessage(
            request,
            sessions.get(ctx.session.sessionId as string)?.capsule,
          )
        : request;
      return next(enriched);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      await verifyCapsule(ctx, resolved, sessions);
      const enriched = resolved.injectMandate
        ? injectMandateMessage(
            request,
            sessions.get(ctx.session.sessionId as string)?.capsule,
          )
        : request;
      yield* next(enriched);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function verifyCapsule(
  ctx: TurnContext,
  resolved: Required<IntentCapsuleConfig>,
  sessions: Map<string, CapsuleEntry>,
): Promise<void> {
  const entry = sessions.get(ctx.session.sessionId as string);
  if (entry === undefined) {
    throw KoiRuntimeError.from(
      "PERMISSION",
      "Intent capsule not found for session",
      {
        context: {
          sessionId: ctx.session.sessionId as string,
          reason: "capsule_violation",
          detail: "capsule_not_found",
        },
      },
    );
  }

  const currentPayload = canonicalizeMandatePayload({
    agentId: ctx.session.agentId,
    sessionId: ctx.session.sessionId as string,
    systemPrompt: resolved.systemPrompt,
    objectives: resolved.objectives,
  });
  const currentMandateHash = computeStringHash(currentPayload);

  const result = await resolved.verifier.verify(entry.capsule, currentMandateHash);

  if (!result.ok) {
    throw KoiRuntimeError.from(
      "PERMISSION",
      "Intent capsule violation: mandate has been tampered",
      {
        context: {
          sessionId: ctx.session.sessionId as string,
          reason: "capsule_violation",
          detail: result.reason,
          capsuleId: entry.capsule.id as string,
        },
      },
    );
  }
}

function evictStaleSessions(
  sessions: Map<string, CapsuleEntry>,
  maxTtlMs: number,
): void {
  const cutoff = Date.now() - maxTtlMs;
  for (const [key, entry] of sessions) {
    if (entry.createdAt < cutoff) {
      sessions.delete(key);
    }
  }
}

function injectMandateMessage(
  request: ModelRequest,
  capsule: IntentCapsule | undefined,
): ModelRequest {
  if (capsule === undefined) return request;
  return {
    ...request,
    messages: [
      {
        senderId: "system:intent-capsule",
        timestamp: capsule.createdAt,
        content: [
          {
            kind: "text",
            text: [
              "[Signed Mandate — v1]",
              `Agent:     ${capsule.agentId}`,
              `Session:   ${capsule.sessionId as string}`,
              `Hash:      ${capsule.mandateHash}`,
              `Signature: ${capsule.signature}`,
              "[/Signed Mandate]",
            ].join("\n"),
          },
        ],
      },
      ...request.messages,
    ],
  };
}
```

Note: `verifyCapsule` uses `Required<IntentCapsuleConfig>` as its type for `resolved`. Import `IntentCapsuleConfig` at the top of the file — it is already imported.

- [ ] **Step 4: Run happy-path tests to verify they pass**

```bash
bun test packages/security/middleware-intent-capsule/src/middleware.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/middleware-intent-capsule/src/middleware.ts packages/security/middleware-intent-capsule/src/middleware.test.ts
git commit -m "feat(middleware-intent-capsule): happy path — session start + model call"
```

---

## Task 5: middleware.ts — violation + error paths TDD

**Files:**
- Modify: `packages/security/middleware-intent-capsule/src/middleware.test.ts`

- [ ] **Step 1: Add failing violation tests**

Append to `packages/security/middleware-intent-capsule/src/middleware.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Violation path — injectable verifier
// ---------------------------------------------------------------------------

import type { CapsuleVerifier, CapsuleVerifyResult, IntentCapsule } from "@koi/core/intent-capsule";

describe("CAPSULE_VIOLATION via injectable verifier", () => {
  beforeEach(() => nextFn.mockClear());

  it("throws PERMISSION with reason=capsule_violation when verifier returns ok=false", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(_capsule: IntentCapsule, _hash: string): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };

    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "Original mission.",
      verifier: mockVerifier,
    });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      code: "PERMISSION",
      context: expect.objectContaining({ reason: "capsule_violation" }),
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("throws capsule_not_found when onSessionStart was never called", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent." });
    const ctx = makeSessionCtx();
    const turn = makeTurnCtx(ctx);

    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      code: "PERMISSION",
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });
  });

  it("includes capsuleId and sessionId in the error context", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(_c: IntentCapsule, _h: string): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };

    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent.", verifier: mockVerifier });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    let thrown: unknown;
    try {
      await mw.wrapModelCall?.(turn, makeModelRequest(), nextFn);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toMatchObject({
      context: expect.objectContaining({
        sessionId: "session-abc",
        capsuleId: expect.stringContaining("agent-test-1"),
      }),
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm 3 new failures (3 old still pass)**

```bash
bun test packages/security/middleware-intent-capsule/src/middleware.test.ts
```

Expected: 3 pass (happy path), 3 fail (new violation tests). The 3 new tests fail because `createIntentCapsuleMiddleware` does not yet exist in middleware.ts — but actually it does from Task 4. These tests should pass immediately if the implementation in Task 4 is correct. Run to verify:

Expected after running: **6 tests pass.**

- [ ] **Step 3: Commit**

```bash
git add packages/security/middleware-intent-capsule/src/middleware.test.ts
git commit -m "test(middleware-intent-capsule): violation path tests"
```

---

## Task 6: middleware.ts — lifecycle + stream + injectMandate TDD

**Files:**
- Modify: `packages/security/middleware-intent-capsule/src/middleware.test.ts`

- [ ] **Step 1: Add lifecycle, stream, and injectMandate tests**

Append to `packages/security/middleware-intent-capsule/src/middleware.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("session lifecycle — cleanup", () => {
  it("removes capsule on onSessionEnd, subsequent call throws capsule_not_found", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Cleanup test." });
    const ctx = makeSessionCtx();

    await mw.onSessionStart?.(ctx);
    await mw.onSessionEnd?.(ctx);

    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });
  });
});

describe("session lifecycle — TTL eviction", () => {
  it("evicts stale sessions when a new onSessionStart fires", async () => {
    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "TTL test.",
      maxTtlMs: 1_000,
    });

    const staleCtx = makeSessionCtx("session-stale");
    await mw.onSessionStart?.(staleCtx);

    // Advance time past TTL
    const origNow = Date.now;
    Date.now = () => origNow() + 2_000;

    try {
      const freshCtx = makeSessionCtx("session-fresh");
      await mw.onSessionStart?.(freshCtx);

      const staleTurn = makeTurnCtx(staleCtx);
      await expect(
        mw.wrapModelCall?.(staleTurn, makeModelRequest(), nextFn),
      ).rejects.toMatchObject({
        context: expect.objectContaining({ detail: "capsule_not_found" }),
      });
    } finally {
      Date.now = origNow;
    }
  });
});

describe("session lifecycle — concurrent sessions", () => {
  it("isolates capsules: ending session-A does not affect session-B", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Concurrent test." });

    const ctxA = makeSessionCtx("session-A");
    const ctxB = makeSessionCtx("session-B");

    await Promise.all([mw.onSessionStart?.(ctxA), mw.onSessionStart?.(ctxB)]);
    await mw.onSessionEnd?.(ctxA);

    // A is gone
    const turnA = makeTurnCtx(ctxA);
    await expect(mw.wrapModelCall?.(turnA, makeModelRequest(), nextFn)).rejects.toMatchObject({
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });

    // B still works
    const turnB = makeTurnCtx(ctxB);
    await expect(mw.wrapModelCall?.(turnB, makeModelRequest(), nextFn)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  it("yields chunks on valid capsule", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Stream agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const streamNext = mock(async function* (_req: ModelRequest): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "Hello " };
      yield { kind: "text_delta", delta: "world" };
      yield { kind: "done", response: { content: "Hello world", model: "test" } };
    });

    const chunks: ModelChunk[] = [];
    const turn = makeTurnCtx(ctx);
    for await (const chunk of mw.wrapModelStream!(turn, makeModelRequest(), streamNext)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "text_delta", delta: "Hello " });
  });

  it("throws PERMISSION on stream when verifier rejects", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent.", verifier: mockVerifier });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const streamNext = mock(async function* (): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "should not reach" };
    });

    const turn = makeTurnCtx(ctx);
    await expect(async () => {
      for await (const _chunk of mw.wrapModelStream!(turn, makeModelRequest(), streamNext)) {
        // consume
      }
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// injectMandate
// ---------------------------------------------------------------------------

describe("injectMandate", () => {
  beforeEach(() => nextFn.mockClear());

  it("prepends signed mandate message when injectMandate=true", async () => {
    let captured: ModelRequest | undefined;
    const capturingNext = mock(async (req: ModelRequest): Promise<ModelResponse> => {
      captured = req;
      return mockResponse;
    });

    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "My mission.",
      injectMandate: true,
    });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);
    await mw.wrapModelCall?.(makeTurnCtx(ctx), makeModelRequest(), capturingNext);

    expect(captured?.messages[0]?.senderId).toBe("system:intent-capsule");
    expect(captured?.messages[0]?.content[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("[Signed Mandate — v1]"),
    });
  });

  it("does not inject when injectMandate=false (default)", async () => {
    let captured: ModelRequest | undefined;
    const capturingNext = mock(async (req: ModelRequest): Promise<ModelResponse> => {
      captured = req;
      return mockResponse;
    });

    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);
    await mw.wrapModelCall?.(makeTurnCtx(ctx), makeModelRequest(), capturingNext);

    expect(captured?.messages[0]?.senderId).not.toBe("system:intent-capsule");
  });
});
```

- [ ] **Step 2: Run all middleware tests**

```bash
bun test packages/security/middleware-intent-capsule/src/middleware.test.ts
```

Expected: 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/security/middleware-intent-capsule/src/middleware.test.ts
git commit -m "test(middleware-intent-capsule): lifecycle, stream, injectMandate tests"
```

---

## Task 7: index.ts + build verify

**Files:**
- Create: `packages/security/middleware-intent-capsule/src/index.ts`

- [ ] **Step 1: Create index.ts**

```typescript
export type { MandateFields } from "./canonicalize.js";
export { canonicalizeMandatePayload } from "./canonicalize.js";
export type { IntentCapsuleConfig } from "./config.js";
export { DEFAULT_CAPSULE_TTL_MS } from "./config.js";
export { createIntentCapsuleMiddleware } from "./middleware.js";
```

- [ ] **Step 2: Run typecheck**

```bash
bun run --cwd packages/security/middleware-intent-capsule typecheck
```

Expected: no errors.

- [ ] **Step 3: Run build**

```bash
bun run --cwd packages/security/middleware-intent-capsule build
```

Expected: `dist/index.js` and `dist/index.d.ts` created, no errors.

- [ ] **Step 4: Run full test suite for the package**

```bash
bun test --filter @koi/middleware-intent-capsule
```

Expected: 18 tests pass (5 canonicalize + 13 middleware).

- [ ] **Step 5: Commit**

```bash
git add packages/security/middleware-intent-capsule/src/index.ts
git commit -m "feat(middleware-intent-capsule): public exports + verified build"
```

---

## Task 8: Wire into layers + @koi/runtime

**Files:**
- Modify: `scripts/layers.ts`
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`

- [ ] **Step 1: Add to L2_PACKAGES in scripts/layers.ts**

In `scripts/layers.ts`, find the `L2_PACKAGES` set and add the entry in alphabetical order with the other middleware packages:

```typescript
// Find this block (around line 86-93):
  "@koi/middleware-ace",
  "@koi/middleware-audit",
  "@koi/middleware-degenerate",
  "@koi/middleware-feedback-loop",
  "@koi/middleware-memory-recall",
  "@koi/middleware-output-verifier",
  "@koi/middleware-strict-agentic",
  "@koi/middleware-turn-prelude",

// Add after @koi/middleware-feedback-loop:
  "@koi/middleware-intent-capsule",
```

The resulting block should look like:
```typescript
  "@koi/middleware-ace",
  "@koi/middleware-audit",
  "@koi/middleware-degenerate",
  "@koi/middleware-feedback-loop",
  "@koi/middleware-intent-capsule",
  "@koi/middleware-memory-recall",
  "@koi/middleware-output-verifier",
  "@koi/middleware-strict-agentic",
  "@koi/middleware-turn-prelude",
```

- [ ] **Step 2: Verify check:layers passes**

```bash
bun run check:layers
```

Expected: no layer violations.

- [ ] **Step 3: Add dep to @koi/runtime package.json**

In `packages/meta/runtime/package.json`, add to `"dependencies"` in alphabetical order:

```json
"@koi/middleware-intent-capsule": "workspace:*",
```

Place it after `@koi/middleware-feedback-loop` and before `@koi/middleware-memory-recall` (alphabetical).

- [ ] **Step 4: Add tsconfig reference in @koi/runtime tsconfig.json**

In `packages/meta/runtime/tsconfig.json`, add to `"references"` array with the other security packages:

```json
{ "path": "../../security/middleware-intent-capsule" },
```

Place it with the other `../../security/middleware-*` entries (alphabetical by path suffix).

- [ ] **Step 5: Run bun install to update lockfile**

```bash
bun install
```

Expected: `bun.lock` updated.

- [ ] **Step 6: Verify check:orphans passes**

```bash
bun run check:orphans
```

Expected: no orphaned packages (the package has `"koi": { "optional": true }` so it is exempt even before wiring, and now it has a consumer).

- [ ] **Step 7: Commit**

```bash
git add scripts/layers.ts packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json bun.lock
git commit -m "chore: wire @koi/middleware-intent-capsule into layers + @koi/runtime"
```

---

## Task 9: Add golden query assertions

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Add golden assertions at end of golden-replay.test.ts**

Append this describe block to the end of `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:

```typescript
describe("Golden: @koi/middleware-intent-capsule", () => {
  test("createIntentCapsuleMiddleware returns a KoiMiddleware with correct name and priority", async () => {
    const { createIntentCapsuleMiddleware } = await import("@koi/middleware-intent-capsule");
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "You are a test agent." });
    expect(mw.name).toBe("intent-capsule");
    expect(mw.priority).toBe(290);
    expect(typeof mw.onSessionStart).toBe("function");
    expect(typeof mw.wrapModelCall).toBe("function");
    expect(typeof mw.wrapModelStream).toBe("function");
    expect(typeof mw.onSessionEnd).toBe("function");
  });

  test("wrapModelCall throws PERMISSION when onSessionStart was not called (fail-closed)", async () => {
    const { createIntentCapsuleMiddleware } = await import("@koi/middleware-intent-capsule");
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Secure agent." });

    const ctx = {
      session: {
        agentId: "agent-golden",
        sessionId: "session-golden" as never,
        runId: "run-golden" as never,
        metadata: {},
      },
      turnIndex: 0,
      turnId: "turn-golden" as never,
      messages: [],
      metadata: {},
    } as never;

    const next = async () => ({ content: "should not reach", model: "test" });
    await expect(
      mw.wrapModelCall!(ctx, { messages: [] }, next),
    ).rejects.toMatchObject({ code: "PERMISSION" });
  });
});
```

- [ ] **Step 2: Run check:golden-queries to verify it passes**

```bash
bun run check:golden-queries
```

Expected: `✅ All N L2 runtime dependencies have golden query coverage.`

- [ ] **Step 3: Run the golden tests**

```bash
bun test --filter @koi/runtime packages/meta/runtime/src/__tests__/golden-replay.test.ts
```

Expected: the 2 new `Golden: @koi/middleware-intent-capsule` tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/meta/runtime/src/__tests__/golden-replay.test.ts
git commit -m "test(runtime): golden queries for @koi/middleware-intent-capsule"
```

---

## Task 10: Update docs

**Files:**
- Modify: `docs/L2/middleware-intent-capsule.md`
- Modify: `docs/L3/runtime.md`

- [ ] **Step 1: Update middleware-intent-capsule.md**

In `docs/L2/middleware-intent-capsule.md`, make these replacements:

1. In the **Layer position** section, replace:
   ```
   L0u @koi/crypto-utils      ─ generateEd25519KeyPair, signEd25519, sha256Hex
   ```
   with:
   ```
   L0u @koi/hash              ─ computeStringHash (SHA-256 via Bun.CryptoHasher)
   node:crypto                ─ generateKeyPairSync, sign (Ed25519)
   ```

2. In the **Layer compliance** section, replace:
   ```
   L0u @koi/crypto-utils ──────────────────────────────────────────────────┐   │
       generateEd25519KeyPair, signEd25519, sha256Hex           │   │
   ```
   with:
   ```
   L0u @koi/hash ──────────────────────────────────────────────────────────┐   │
       computeStringHash (SHA-256)                              │   │
   ```

3. In the **Injectable verifier** section, remove the `import { verifyEd25519, sha256Hex } from "@koi/crypto-utils";` line from the strict verifier example and replace with:
   ```typescript
   import { computeStringHash } from "@koi/hash";
   import { createPublicKey, verify } from "node:crypto";
   ```

4. In the **Related** section, replace:
   ```
   - [`@koi/crypto-utils`](./crypto-utils.md) — Ed25519 + SHA-256 primitives used by this package
   ```
   with:
   ```
   - [`@koi/hash`](./hash.md) — SHA-256 hashing via `computeStringHash`
   - [`@koi/governance-delegation`](./governance-delegation.md) — Ed25519 pattern reference (same `node:crypto` approach)
   ```

5. Update the **Default verifier** code block to show hash-only (no signature check):
   ```typescript
   const defaultVerifier: CapsuleVerifier = {
     verify(capsule, currentMandateHash) {
       if (capsule.mandateHash !== currentMandateHash) {
         return { ok: false, reason: "mandate_hash_mismatch" };
       }
       return { ok: true, capsule };
     },
   };
   ```

- [ ] **Step 2: Update runtime.md**

In `docs/L3/runtime.md`, in the integrated packages table (near the `@koi/middleware-audit`, `@koi/middleware-permissions` entries), add a row:

```markdown
| `@koi/middleware-intent-capsule` | Cryptographic mandate binding — OWASP ASI01 goal-hijack defense (Ed25519 session signing, hash verification on hot path) |
```

Also add a changelog entry at the top of the changelog section:

```markdown
`@koi/middleware-intent-capsule` wired (#1883 gov-16): Ed25519 mandate binding middleware added as a dependency of `@koi/runtime`; golden query assertions added.
```

- [ ] **Step 3: Run doc wiring checks**

```bash
bun run check:doc-gate
bun run check:doc-wiring
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add docs/L2/middleware-intent-capsule.md docs/L3/runtime.md
git commit -m "docs: update middleware-intent-capsule + runtime docs for v2 wiring"
```

---

## Task 11: Final CI gate verification

- [ ] **Step 1: Run all unit tests for the package**

```bash
bun test --filter @koi/middleware-intent-capsule
```

Expected: 18 tests pass.

- [ ] **Step 2: Run typecheck**

```bash
bun run --cwd packages/security/middleware-intent-capsule typecheck
```

Expected: no errors.

- [ ] **Step 3: Run lint**

```bash
bun run --cwd packages/security/middleware-intent-capsule lint
```

Expected: no errors.

- [ ] **Step 4: Run layer checks**

```bash
bun run check:layers && bun run check:orphans && bun run check:golden-queries
```

Expected: all three pass.

- [ ] **Step 5: Run doc checks**

```bash
bun run check:doc-gate && bun run check:doc-wiring
```

Expected: both pass.

---

## Self-Review Notes

**Spec coverage check:**
- ✅ `@koi/middleware-intent-capsule` package created (Task 1)
- ✅ `createIntentCapsuleMiddleware({ systemPrompt, objectives, ... })` (Task 4)
- ✅ `onSessionStart`: Ed25519 keygen + mandate signing (Task 4)
- ✅ `wrapModelCall` + `wrapModelStream`: hash verify + fail-closed (Task 4-6)
- ✅ `onSessionEnd`: capsule cleanup (Task 6)
- ✅ TTL eviction (Task 6)
- ✅ Injectable verifier for testing (Task 5)
- ✅ `injectMandate` option (Task 6)
- ✅ `canonicalizeMandatePayload` exported utility (Task 2, 7)
- ✅ `DEFAULT_CAPSULE_TTL_MS` exported (Task 3, 7)
- ✅ All 13 test cases from v1 ported (Tasks 4-6)
- ✅ Wired into L2_PACKAGES + @koi/runtime (Task 8)
- ✅ Golden queries (Task 9)
- ✅ Doc updated (Task 10)
- ✅ Nexus signer deferred — explicitly out of scope

**Type consistency check:**
- `MandateFields` defined in `canonicalize.ts`, used by `middleware.ts` ✅
- `IntentCapsuleConfig` defined in `config.ts`, used by `middleware.ts` ✅
- `CapsuleEntry` is internal to `middleware.ts` ✅
- `resolveConfig` returns `Required<IntentCapsuleConfig>` — used as parameter type in `verifyCapsule` ✅
- `capsuleId` constructor from `@koi/core/intent-capsule` ✅
- `computeStringHash` from `@koi/hash` ✅
