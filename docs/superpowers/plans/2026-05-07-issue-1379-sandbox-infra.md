# Issue 1379 Sandbox Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@koi/sandbox-cloud-base` as a new L0u package and `@koi/sandbox-ipc` as a new L2 package, with test-covered shared profile-validation helpers, cached bridge utilities, and a structured Bun-child IPC bridge that adapts to the existing `SandboxExecutor` contract.

**Architecture:** Land the work in two layers. First, add a small L0u helper package in `packages/lib/sandbox-cloud-base` and prove it by migrating one hosted adapter to its shared validation helpers. Then add `packages/sandbox/sandbox-ipc`, keeping platform-specific process wrapping injected so the package stays layer-clean and reuses `@koi/sandbox-cloud-base` only for bridge-neutral helper logic. `@koi/sandbox-executor` remains the consumer-facing execution contract; `@koi/sandbox-ipc` adapts to it rather than replacing it.

**Tech Stack:** TypeScript 6, Bun 1.3.x, `bun:test`, tsup ESM-only builds, strict L0/L0u/L2 layering, Biome, Turborepo workspace packages.

**Spec:** `docs/superpowers/specs/2026-05-07-issue-1379-sandbox-infra-design.md`

---

## File Structure

### Files to create

| Path | Purpose |
|------|---------|
| `packages/lib/sandbox-cloud-base/package.json` | New L0u package manifest |
| `packages/lib/sandbox-cloud-base/tsconfig.json` | TS project config |
| `packages/lib/sandbox-cloud-base/tsup.config.ts` | Build config |
| `packages/lib/sandbox-cloud-base/src/index.ts` | Public exports |
| `packages/lib/sandbox-cloud-base/src/validate-profile.ts` | Shared hosted-backend profile detection + formatting |
| `packages/lib/sandbox-cloud-base/src/cached-bridge.ts` | Generic cached bridge lifecycle helper |
| `packages/lib/sandbox-cloud-base/src/line-reader.ts` | Bounded NDJSON / line-oriented stream reader |
| `packages/lib/sandbox-cloud-base/src/output-accumulator.ts` | Byte-accurate bounded output collector |
| `packages/lib/sandbox-cloud-base/src/guard.ts` | Destroy/dispose guard helpers |
| `packages/lib/sandbox-cloud-base/src/*.test.ts` | Unit tests for each helper group |
| `packages/sandbox/sandbox-ipc/package.json` | New L2 package manifest |
| `packages/sandbox/sandbox-ipc/tsconfig.json` | TS project config |
| `packages/sandbox/sandbox-ipc/tsup.config.ts` | Build config |
| `packages/sandbox/sandbox-ipc/src/index.ts` | Public exports |
| `packages/sandbox/sandbox-ipc/src/types.ts` | Bridge config/result/error/process abstractions |
| `packages/sandbox/sandbox-ipc/src/protocol.ts` | Message schema validation + parsers |
| `packages/sandbox/sandbox-ipc/src/errors.ts` | IPC error constructors + mapping helpers |
| `packages/sandbox/sandbox-ipc/src/bridge.ts` | Core structured bridge implementation |
| `packages/sandbox/sandbox-ipc/src/adapter.ts` | `bridgeToExecutor()` adapter surface |
| `packages/sandbox/sandbox-ipc/src/worker-source.ts` | Bun child worker source |
| `packages/sandbox/sandbox-ipc/src/*.test.ts` | Protocol/bridge/adapter/integration tests |
| `docs/L0u/sandbox-cloud-base.md` | L0u package doc |
| `docs/L2/sandbox-ipc.md` | L2 package doc |

### Files to modify

| Path | Change |
|------|--------|
| `scripts/layers.ts` | Register `@koi/sandbox-cloud-base` as L0u and `@koi/sandbox-ipc` as L2 |
| `packages/sandbox/sandbox-e2b/src/profile.ts` | Switch to shared profile-validation helper |
| `packages/sandbox/sandbox-e2b/src/adapter.ts` | Update imports or call sites after helper extraction |
| `packages/sandbox/sandbox-e2b/src/*.test.ts` | Prove shared helper reuse in a real adapter |

### Files deliberately not touched

- `packages/sandbox/sandbox-executor/src/subprocess-executor.ts`
- `packages/sandbox/sandbox-router/*`
- `packages/meta/runtime/*`
- `docs/L3/sandbox-stack.md`

Those areas are intentionally out of scope for this issue slice.

---

## Task 1: Scaffold `@koi/sandbox-cloud-base` package

**Files:**
- Create: `packages/lib/sandbox-cloud-base/package.json`
- Create: `packages/lib/sandbox-cloud-base/tsconfig.json`
- Create: `packages/lib/sandbox-cloud-base/tsup.config.ts`
- Create: `packages/lib/sandbox-cloud-base/src/index.ts`
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Write the failing layer-registration test by updating `scripts/layers.ts` references in a local typecheck expectation**

There is no dedicated failing unit test for package registration, so the “failing test” for this task is the repo-level layer tooling. Start by adding the package names in the canonical sets:

```typescript
// scripts/layers.ts
export const L0U_PACKAGES: ReadonlySet<string> = new Set([
  // ...
  "@koi/sandbox-cloud-base",
  // ...
]);

export const L2_PACKAGES: ReadonlySet<string> = new Set([
  // ...
  "@koi/sandbox-ipc",
  // ...
]);
```

- [ ] **Step 2: Create package scaffolding matching existing package templates**

```json
// packages/lib/sandbox-cloud-base/package.json
{
  "name": "@koi/sandbox-cloud-base",
  "description": "Shared bridge and hosted-sandbox helpers for cloud-backed execution",
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
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  }
}
```

```json
// packages/lib/sandbox-cloud-base/tsconfig.json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../kernel/core" }]
}
```

```typescript
// packages/lib/sandbox-cloud-base/tsup.config.ts
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

```typescript
// packages/lib/sandbox-cloud-base/src/index.ts
export type { CachedBridge, CachedBridgeConfig, CachedBridgeLease } from "./cached-bridge.js";
export { createCachedBridge } from "./cached-bridge.js";
export type { UnsupportedProfileFields } from "./validate-profile.js";
export {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "./validate-profile.js";
export type { LineReaderEvent, LineReaderOptions } from "./line-reader.js";
export { createLineReader } from "./line-reader.js";
export type { OutputAccumulator, OutputAccumulatorChunk } from "./output-accumulator.js";
export { createOutputAccumulator } from "./output-accumulator.js";
export type { GuardState } from "./guard.js";
export { createDestroyGuard } from "./guard.js";
```

- [ ] **Step 3: Run package typecheck to verify scaffolding compiles once source files exist**

Run: `bun run --cwd packages/lib/sandbox-cloud-base typecheck`

Expected: FAIL initially because source modules referenced by `index.ts` do not exist yet.

- [ ] **Step 4: Commit**

```bash
git add scripts/layers.ts packages/lib/sandbox-cloud-base
git commit -m "feat: scaffold sandbox-cloud-base package"
```

---

## Task 2: Build and test shared profile validation first

**Files:**
- Create: `packages/lib/sandbox-cloud-base/src/validate-profile.ts`
- Create: `packages/lib/sandbox-cloud-base/src/validate-profile.test.ts`
- Modify: `packages/lib/sandbox-cloud-base/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/lib/sandbox-cloud-base/src/validate-profile.test.ts
import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "./validate-profile.js";

const permissive: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: true },
  resources: {},
};

describe("detectUnsupportedProfileFields", () => {
  test("returns undefined for a permissive hosted profile", () => {
    expect(detectUnsupportedProfileFields(permissive)).toBeUndefined();
  });

  test("flags closed filesystem, network deny, and resource caps", () => {
    const result = detectUnsupportedProfileFields({
      filesystem: { defaultReadAccess: "closed", allowRead: ["/tmp"] },
      network: { allow: false },
      resources: { maxMemoryMb: 128, maxPids: 32 },
    });
    expect(result).toBeDefined();
    expect(result?.filesystem).toBe(true);
    expect(result?.network).toBe(true);
    expect(result?.resources).toBe(true);
    expect(result?.details.length).toBeGreaterThan(0);
  });

  test("formats adapter-specific fail-closed guidance", () => {
    const message = formatUnsupportedProfileError("sandbox-e2b", {
      filesystem: false,
      network: true,
      resources: false,
      details: ["network deny (allow=false)"],
    });
    expect(message).toContain("sandbox-e2b");
    expect(message).toContain("network deny");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/lib/sandbox-cloud-base/src/validate-profile.test.ts`

Expected: FAIL with module-not-found or missing export errors.

- [ ] **Step 3: Implement the minimal helper**

```typescript
// packages/lib/sandbox-cloud-base/src/validate-profile.ts
import type { SandboxProfile } from "@koi/core";

export interface UnsupportedProfileFields {
  readonly filesystem: boolean;
  readonly network: boolean;
  readonly resources: boolean;
  readonly details: readonly string[];
}

export function detectUnsupportedProfileFields(
  profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  const details: string[] = [];

  const filesystem =
    profile.filesystem.defaultReadAccess === "closed" ||
    (profile.filesystem.allowRead?.length ?? 0) > 0 ||
    (profile.filesystem.allowWrite?.length ?? 0) > 0 ||
    (profile.filesystem.denyRead?.length ?? 0) > 0 ||
    (profile.filesystem.denyWrite?.length ?? 0) > 0 ||
    (profile.nexusMounts?.length ?? 0) > 0;

  if (filesystem) details.push("filesystem restrictions or Nexus mounts");

  const network = profile.network.allow === false;
  if (network) details.push("network deny (allow=false)");

  const resources =
    profile.resources.maxMemoryMb !== undefined ||
    profile.resources.maxPids !== undefined ||
    profile.resources.maxOpenFiles !== undefined;

  if (resources) details.push("resource limits (maxMemoryMb/maxPids/maxOpenFiles)");

  if (!filesystem && !network && !resources) return undefined;

  return { filesystem, network, resources, details };
}

export function formatUnsupportedProfileError(
  adapterName: string,
  unsupported: UnsupportedProfileFields,
): string {
  return (
    `${adapterName} cannot enforce the following SandboxProfile policies: ` +
    `${unsupported.details.join(", ")}. Use @koi/sandbox-docker or @koi/sandbox-os ` +
    `for policy enforcement, or relax the profile to proceed.`
  );
}
```

- [ ] **Step 4: Re-run the test and package typecheck**

Run:
- `bun test packages/lib/sandbox-cloud-base/src/validate-profile.test.ts`
- `bun run --cwd packages/lib/sandbox-cloud-base typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/sandbox-cloud-base/src/index.ts \
  packages/lib/sandbox-cloud-base/src/validate-profile.ts \
  packages/lib/sandbox-cloud-base/src/validate-profile.test.ts
git commit -m "feat: add sandbox-cloud-base profile validation helpers"
```

---

## Task 3: Prove real adapter reuse with `sandbox-e2b`

**Files:**
- Modify: `packages/sandbox/sandbox-e2b/src/profile.ts`
- Modify: `packages/sandbox/sandbox-e2b/src/adapter.ts` if imports change
- Modify: `packages/sandbox/sandbox-e2b/src/adapter.test.ts` and/or `profile.test.ts`
- Modify: `packages/sandbox/sandbox-e2b/package.json`

- [ ] **Step 1: Write the failing adapter-level proof test**

Add or extend a test that asserts the shared helper still rejects unsupported policies with the same fail-closed behavior:

```typescript
test("create() rejects unsupported hosted profile fields via shared helper", async () => {
  const adapter = createE2bAdapter(validConfig());
  if (!adapter.ok) throw new Error("expected adapter");

  await expect(
    adapter.value.create({
      filesystem: { defaultReadAccess: "closed" },
      network: { allow: false },
      resources: {},
    }),
  ).rejects.toThrow("SandboxProfile policies");
});
```

- [ ] **Step 2: Run the package test to verify failure after import switch**

Run: `bun test packages/sandbox/sandbox-e2b/src`

Expected: FAIL once local helper code is removed and imports are not yet updated.

- [ ] **Step 3: Add the L0u dependency and migrate the code**

```json
// packages/sandbox/sandbox-e2b/package.json
{
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/sandbox-cloud-base": "workspace:*"
  }
}
```

In `packages/sandbox/sandbox-e2b/src/profile.ts`, replace package-local detection logic with:

```typescript
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "@koi/sandbox-cloud-base";
```

and keep only any E2B-specific wrapper helpers that are genuinely adapter-specific.

- [ ] **Step 4: Re-run tests**

Run:
- `bun test packages/sandbox/sandbox-e2b/src`
- `bun run --cwd packages/sandbox/sandbox-e2b typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-e2b/package.json \
  packages/sandbox/sandbox-e2b/src/profile.ts \
  packages/sandbox/sandbox-e2b/src/adapter.ts \
  packages/sandbox/sandbox-e2b/src/*.test.ts
git commit -m "refactor: share hosted profile validation in sandbox-e2b"
```

---

## Task 4: Add cached bridge, guard, line reader, and output accumulator helpers

**Files:**
- Create: `packages/lib/sandbox-cloud-base/src/cached-bridge.ts`
- Create: `packages/lib/sandbox-cloud-base/src/cached-bridge.test.ts`
- Create: `packages/lib/sandbox-cloud-base/src/guard.ts`
- Create: `packages/lib/sandbox-cloud-base/src/guard.test.ts`
- Create: `packages/lib/sandbox-cloud-base/src/line-reader.ts`
- Create: `packages/lib/sandbox-cloud-base/src/line-reader.test.ts`
- Create: `packages/lib/sandbox-cloud-base/src/output-accumulator.ts`
- Create: `packages/lib/sandbox-cloud-base/src/output-accumulator.test.ts`
- Modify: `packages/lib/sandbox-cloud-base/src/index.ts`

- [ ] **Step 1: Write the failing tests first**

Cover these concrete behaviors:

- cached bridge creates underlying lease only once for concurrent callers
- cached bridge expires after TTL and calls `dispose`
- destroy guard throws or returns false once disposed
- line reader reconstructs newline-delimited JSON across chunk boundaries
- output accumulator truncates by byte count without corrupting UTF-8

Use a fake lease shape like:

```typescript
interface FakeLease {
  readonly execute: (payload: string) => Promise<string>;
  readonly dispose: () => Promise<void>;
}
```

- [ ] **Step 2: Run only the new helper tests**

Run:
- `bun test packages/lib/sandbox-cloud-base/src/cached-bridge.test.ts`
- `bun test packages/lib/sandbox-cloud-base/src/guard.test.ts`
- `bun test packages/lib/sandbox-cloud-base/src/line-reader.test.ts`
- `bun test packages/lib/sandbox-cloud-base/src/output-accumulator.test.ts`

Expected: FAIL with missing module/export errors.

- [ ] **Step 3: Implement the minimal helpers**

Key implementation rules:

- `cached-bridge.ts` should be generic and must not import L2 types
- `guard.ts` should expose a tiny stateful closure, not a class
- `line-reader.ts` should accept a `ReadableStream<Uint8Array>` and surface parsed lines through an async iterator or callback-based collector
- `output-accumulator.ts` should use `Buffer.byteLength` and slice safely at UTF-8 boundaries

Minimal cached bridge shape:

```typescript
export interface CachedBridgeLease<TInput, TOutput> {
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly dispose: () => Promise<void>;
}

export interface CachedBridgeConfig<TInput, TOutput> {
  readonly ttlMs: number;
  readonly acquire: () => Promise<CachedBridgeLease<TInput, TOutput>>;
}

export interface CachedBridge<TInput, TOutput> {
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly dispose: () => Promise<void>;
}
```

- [ ] **Step 4: Run package tests and package typecheck**

Run:
- `bun test packages/lib/sandbox-cloud-base/src`
- `bun run --cwd packages/lib/sandbox-cloud-base typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/sandbox-cloud-base/src
git commit -m "feat: add sandbox-cloud-base bridge and stream helpers"
```

---

## Task 5: Scaffold and implement `@koi/sandbox-ipc` protocol + errors

**Files:**
- Create: `packages/sandbox/sandbox-ipc/package.json`
- Create: `packages/sandbox/sandbox-ipc/tsconfig.json`
- Create: `packages/sandbox/sandbox-ipc/tsup.config.ts`
- Create: `packages/sandbox/sandbox-ipc/src/index.ts`
- Create: `packages/sandbox/sandbox-ipc/src/types.ts`
- Create: `packages/sandbox/sandbox-ipc/src/protocol.ts`
- Create: `packages/sandbox/sandbox-ipc/src/protocol.test.ts`
- Create: `packages/sandbox/sandbox-ipc/src/errors.ts`
- Create: `packages/sandbox/sandbox-ipc/src/errors.test.ts` if useful

- [ ] **Step 1: Write the failing protocol tests**

Write parse tests for four messages:

```typescript
const ready = { kind: "ready" };
const execute = { kind: "execute", code: "return 1", input: { x: 1 }, timeoutMs: 500 };
const result = { kind: "result", output: { ok: true }, durationMs: 2 };
const error = { kind: "error", code: "CRASH", message: "boom" };
```

Test expectations:

- valid shapes parse successfully
- invalid `kind` is rejected
- missing required fields are rejected
- unexpected primitive values are rejected

- [ ] **Step 2: Run the protocol test**

Run: `bun test packages/sandbox/sandbox-ipc/src/protocol.test.ts`

Expected: FAIL.

- [ ] **Step 3: Scaffold the package and implement minimal parsers**

Package manifest should mirror `packages/sandbox/sandbox-executor/package.json`, but with `@koi/sandbox-cloud-base` as a dependency:

```json
{
  "name": "@koi/sandbox-ipc",
  "description": "Structured host-worker IPC bridge for sandboxed code execution",
  "version": "0.1.0",
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
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/sandbox-cloud-base": "workspace:*"
  }
}
```

In `protocol.ts`, implement small predicate-based parsers instead of bringing in a new runtime schema dependency.

- [ ] **Step 4: Re-run protocol test and package typecheck**

Run:
- `bun test packages/sandbox/sandbox-ipc/src/protocol.test.ts`
- `bun run --cwd packages/sandbox/sandbox-ipc typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-ipc
git commit -m "feat: scaffold sandbox-ipc protocol and error surfaces"
```

---

## Task 6: Implement bridge core and real Bun-child integration

**Files:**
- Create: `packages/sandbox/sandbox-ipc/src/bridge.ts`
- Create: `packages/sandbox/sandbox-ipc/src/worker-source.ts`
- Create: `packages/sandbox/sandbox-ipc/src/bridge.test.ts`
- Create: `packages/sandbox/sandbox-ipc/src/integration.test.ts`

- [ ] **Step 1: Write failing bridge unit tests**

Cover:

- happy path result
- worker-thrown error mapped to bridge error
- timeout path
- oversize result path
- dispose path

Fake process shape:

```typescript
const proc: IpcProcess = {
  pid: 1,
  exited: Promise.resolve(0),
  kill: () => {},
  send: () => {},
  onMessage: () => {},
  onExit: () => {},
};
```

- [ ] **Step 2: Write the failing integration test with a real Bun child**

Use a real `createSandboxBridge()` call with an injected command builder that simply spawns:

```typescript
{
  executable: "bun",
  args: ["run", workerPath]
}
```

and verify:

- input arrives at the worker
- output returns to the host
- thrown worker code becomes a typed error result

- [ ] **Step 3: Run unit + integration tests to verify failure**

Run:
- `bun test packages/sandbox/sandbox-ipc/src/bridge.test.ts`
- `bun test packages/sandbox/sandbox-ipc/src/integration.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the bridge**

Implementation rules:

- keep command building injected
- use `Bun.spawn` with `ipc` callback support
- kill the worker on timeout or malformed message
- validate every inbound message through the protocol parser
- keep result size enforcement in the host bridge

Minimal bridge API:

```typescript
export interface SandboxBridge {
  readonly execute: (
    code: string,
    input: Record<string, unknown>,
    options?: BridgeExecOptions,
  ) => Promise<Result<BridgeResult, IpcError>>;
  readonly dispose: () => Promise<void>;
}
```

Worker behavior:

- send `{ kind: "ready" }` on boot
- accept one `{ kind: "execute", ... }` message
- run the provided code in Bun/JS
- respond with `{ kind: "result", ... }` or `{ kind: "error", ... }`

- [ ] **Step 5: Re-run bridge tests**

Run:
- `bun test packages/sandbox/sandbox-ipc/src/bridge.test.ts`
- `bun test packages/sandbox/sandbox-ipc/src/integration.test.ts`
- `bun run --cwd packages/sandbox/sandbox-ipc typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/sandbox-ipc/src
git commit -m "feat: implement sandbox-ipc bridge core"
```

---

## Task 7: Add `bridgeToExecutor()` adapter and docs

**Files:**
- Create: `packages/sandbox/sandbox-ipc/src/adapter.ts`
- Create: `packages/sandbox/sandbox-ipc/src/adapter.test.ts`
- Modify: `packages/sandbox/sandbox-ipc/src/index.ts`
- Create: `docs/L0u/sandbox-cloud-base.md`
- Create: `docs/L2/sandbox-ipc.md`

- [ ] **Step 1: Write the failing adapter test**

Test that `bridgeToExecutor()` returns a `SandboxExecutor`-compatible object:

```typescript
test("bridgeToExecutor adapts bridge failures into SandboxError results", async () => {
  const executor = bridgeToExecutor(validBridgeConfig());
  const result = await executor.execute("throw new Error('boom')", {}, 500);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error.code).toBe("CRASH");
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `bun test packages/sandbox/sandbox-ipc/src/adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the adapter and docs**

Adapter mapping rules:

- `TIMEOUT` -> `SandboxError { code: "TIMEOUT" }`
- `OOM` -> `SandboxError { code: "OOM" }`
- `WORKER_ERROR`, `CRASH`, `DESERIALIZE`, `RESULT_TOO_LARGE`, `SPAWN_FAILED`, `DISPOSED` -> `SandboxError { code: "CRASH" }` unless a more specific mapping is clearly warranted

Doc outlines:

```md
# @koi/sandbox-cloud-base
- layer: L0u
- purpose: shared bridge + hosted backend helpers
- current surface: profile validation, cached bridge, line reader, output accumulator, guards
- non-goals: no runtime routing, no meta-stack
```

```md
# @koi/sandbox-ipc
- layer: L2
- purpose: structured host-worker bridge
- injected command builder keeps the package layer-clean
- `bridgeToExecutor()` is the compatibility surface for SandboxExecutor consumers
```

- [ ] **Step 4: Run focused tests and doc/layer gates**

Run:
- `bun test packages/sandbox/sandbox-ipc/src/adapter.test.ts`
- `bun run check:layers`
- `bun run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-ipc/src/adapter.ts \
  packages/sandbox/sandbox-ipc/src/adapter.test.ts \
  packages/sandbox/sandbox-ipc/src/index.ts \
  docs/L0u/sandbox-cloud-base.md \
  docs/L2/sandbox-ipc.md
git commit -m "feat: expose sandbox-ipc executor adapter and docs"
```

---

## Task 8: Final verification and finish checklist

**Files:**
- Review-only task; no intentional code creation

- [ ] **Step 1: Run package-local tests**

Run:
- `bun test packages/lib/sandbox-cloud-base/src`
- `bun test packages/sandbox/sandbox-ipc/src`
- `bun test packages/sandbox/sandbox-e2b/src`

Expected: PASS.

- [ ] **Step 2: Run workspace verification**

Run:
- `bun run typecheck`
- `bun run lint`
- `bun run check:layers`

Expected: PASS.

- [ ] **Step 3: Sanity-check changed files**

Run:
- `git diff --stat main...HEAD`
- `git status --short`

Expected:
- diff limited to the two new packages, one adapter migration, docs, and layer registration
- clean working tree

- [ ] **Step 4: Final commit if verification fixes were required**

```bash
git add .
git commit -m "chore: finalize issue 1379 sandbox infra"
```

Only do this if the previous tasks left uncommitted verification fixes.

---

## Self-Review

### Spec coverage

- `@koi/sandbox-cloud-base` package: covered by Tasks 1-4
- `@koi/sandbox-ipc` package: covered by Tasks 5-7
- executor-facing adapter: covered by Task 7
- reusable higher-level bridge API: covered by Tasks 5-6
- real hosted-adapter reuse proof: covered by Task 3
- docs and layer registration: covered by Tasks 1 and 7
- verification: covered by Task 8

### Placeholder scan

- no `TBD` / `TODO` / “implement later” placeholders remain
- every task names exact files and commands

### Type consistency

- L0u package name: `@koi/sandbox-cloud-base`
- L2 package name: `@koi/sandbox-ipc`
- consumer execution contract remains `SandboxExecutor`
- bridge surface names consistently use `Bridge*` / `SandboxBridge`
