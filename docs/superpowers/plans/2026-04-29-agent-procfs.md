# `@koi/agent-procfs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the L2 package `@koi/agent-procfs` — a Linux-`/proc`-style virtual filesystem for inspecting running agent state, with a TTL microcache and an auto-mounter that watches the agent registry.

**Architecture:** Pure L2 package importing only `@koi/core` (L0). Two components: (1) `createProcFs()` returns a `ProcFs` implementation backed by a `Map<path, ProcEntry>` plus a per-path TTL cache; (2) `createAgentMounter()` subscribes to `AgentRegistry.watch()` and mounts/unmounts seven entries (`status`, `tools`, `middleware`, `children`, `config`, `env`, `metrics`) per agent. The `metrics` entry is writable and patches `priority` via `registry.patch()`. No L1 dependency, no engine assumptions.

**Tech Stack:** TypeScript 6 (strict), Bun runtime, `bun:test` test runner, tsup for ESM build, Biome for lint. Package manager: `bun install`.

**Spec:** `docs/L2/agent-procfs.md` (authoritative).

**Reference (port + simplify):** `archive/v1/packages/observability/agent-procfs/src/`.

**Issue:** #1378 (v2 Phase 3-obs-2).

---

## File Structure

```
packages/lib/agent-procfs/
├── package.json                       ← workspace package, dep on @koi/core only
├── tsconfig.json                      ← extends ../../../tsconfig.base.json
├── tsup.config.ts                     ← ESM-only, dts on, target node22
└── src/
    ├── index.ts                       ← public re-exports
    ├── procfs-impl.ts                 ← createProcFs() + TTL microcache
    ├── procfs-impl.test.ts            ← unit tests for ProcFs
    ├── agent-mounter.ts               ← createAgentMounter() — registry watcher
    ├── agent-mounter.test.ts          ← unit tests for mounter (incl. churn)
    └── entries/
        ├── index.ts                   ← buildAgentEntries(agent, registry)
        ├── status.ts                  ← /agents/<id>/status entry factory
        ├── tools.ts                   ← /agents/<id>/tools
        ├── middleware.ts              ← /agents/<id>/middleware
        ├── children.ts                ← /agents/<id>/children
        ├── config.ts                  ← /agents/<id>/config
        ├── env.ts                     ← /agents/<id>/env
        └── metrics.ts                 ← /agents/<id>/metrics (writable)
```

---

## Task 1 — Scaffold the package

**Files:**
- Create: `packages/lib/agent-procfs/package.json`
- Create: `packages/lib/agent-procfs/tsconfig.json`
- Create: `packages/lib/agent-procfs/tsup.config.ts`
- Create: `packages/lib/agent-procfs/src/index.ts` (empty stub)

- [ ] **Step 1: Create `package.json`** — copy the shape from `packages/lib/event-trace/package.json`, change name and description.

```json
{
  "name": "@koi/agent-procfs",
  "description": "Virtual /proc-style filesystem for inspecting running agent state",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
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

- [ ] **Step 3: Create `tsup.config.ts`**

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

- [ ] **Step 4: Create `src/index.ts`** with placeholder export to make build green.

```typescript
export {};
```

- [ ] **Step 5: Verify workspace registers the package**

Run: `bun install`
Expected: no errors; `node_modules/@koi/agent-procfs` symlink exists.

- [ ] **Step 6: Verify build/typecheck pass**

Run: `bun --cwd packages/lib/agent-procfs run build && bun --cwd packages/lib/agent-procfs run typecheck`
Expected: exit 0, `dist/index.js` and `dist/index.d.ts` produced.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/agent-procfs/
git commit -m "feat(agent-procfs): scaffold L2 package"
```

---

## Task 2 — `createProcFs()` (ProcFs implementation + TTL cache)

**Spec section:** "TTL Microcache", "ProcFs methods" (`docs/L2/agent-procfs.md` §TTL/§API).
**V1 reference:** `archive/v1/packages/observability/agent-procfs/src/procfs-impl.ts` (port and simplify).

**Files:**
- Create: `packages/lib/agent-procfs/src/procfs-impl.ts`
- Create: `packages/lib/agent-procfs/src/procfs-impl.test.ts`

- [ ] **Step 1: Write the failing test file** — colocated `procfs-impl.test.ts`. Cover the 13 scenarios from spec §Testing.

```typescript
import { describe, expect, test } from "bun:test";
import type { ProcEntry, WritableProcEntry } from "@koi/core";
import { createProcFs } from "./procfs-impl.js";

describe("createProcFs", () => {
  test("mount and read returns entry value", async () => {
    const procFs = createProcFs();
    const entry: ProcEntry = { read: () => 42 };
    procFs.mount("/a", entry);
    expect(await procFs.read("/a")).toBe(42);
  });

  test("read missing path throws KoiError NOT_FOUND", async () => {
    const procFs = createProcFs();
    await expect(procFs.read("/missing")).rejects.toThrow(/NOT_FOUND|not found/i);
  });

  test("TTL cache returns cached value within TTL", async () => {
    let calls = 0;
    const entry: ProcEntry = { read: () => ++calls };
    const procFs = createProcFs({ cacheTtlMs: 1000 });
    procFs.mount("/c", entry);
    expect(await procFs.read("/c")).toBe(1);
    expect(await procFs.read("/c")).toBe(1); // cached
    expect(calls).toBe(1);
  });

  test("TTL=0 disables cache", async () => {
    let calls = 0;
    const entry: ProcEntry = { read: () => ++calls };
    const procFs = createProcFs({ cacheTtlMs: 0 });
    procFs.mount("/c", entry);
    await procFs.read("/c");
    await procFs.read("/c");
    expect(calls).toBe(2);
  });

  test("write invalidates cache and calls entry.write", async () => {
    let val = 1;
    const entry: WritableProcEntry = {
      read: () => val,
      write: (v) => {
        val = v as number;
      },
    };
    const procFs = createProcFs({ cacheTtlMs: 10_000 });
    procFs.mount("/m", entry);
    expect(await procFs.read("/m")).toBe(1);
    await procFs.write("/m", 99);
    expect(await procFs.read("/m")).toBe(99); // not stale
  });

  test("write to read-only entry throws", async () => {
    const procFs = createProcFs();
    procFs.mount("/r", { read: () => 1 });
    await expect(procFs.write("/r", 2)).rejects.toThrow(/not writable|read.?only/i);
  });

  test("mount replaces existing entry and invalidates cache", async () => {
    const procFs = createProcFs({ cacheTtlMs: 10_000 });
    procFs.mount("/p", { read: () => "old" });
    await procFs.read("/p"); // prime cache
    procFs.mount("/p", { read: () => "new" });
    expect(await procFs.read("/p")).toBe("new");
  });

  test("unmount removes entry", async () => {
    const procFs = createProcFs();
    procFs.mount("/u", { read: () => 1 });
    procFs.unmount("/u");
    await expect(procFs.read("/u")).rejects.toThrow();
  });

  test("list returns child segments under a path prefix", async () => {
    const procFs = createProcFs();
    procFs.mount("/agents/a/status", { read: () => "ok" });
    procFs.mount("/agents/a/tools", { read: () => [] });
    procFs.mount("/agents/b/status", { read: () => "ok" });
    const children = await procFs.list("/agents");
    expect([...children].sort()).toEqual(["a", "b"]);
  });

  test("entries returns all mounted paths", () => {
    const procFs = createProcFs();
    procFs.mount("/x", { read: () => 0 });
    procFs.mount("/y", { read: () => 0 });
    expect([...procFs.entries()].sort()).toEqual(["/x", "/y"]);
  });

  test("entry-provided list() takes precedence over derived listing", async () => {
    const procFs = createProcFs();
    procFs.mount("/dyn", {
      read: () => null,
      list: () => ["k1", "k2"],
    });
    expect([...(await procFs.list("/dyn"))].sort()).toEqual(["k1", "k2"]);
  });

  test("async read is awaited", async () => {
    const procFs = createProcFs();
    procFs.mount("/async", { read: async () => "deferred" });
    expect(await procFs.read("/async")).toBe("deferred");
  });

  test("cache expires after TTL elapses", async () => {
    let calls = 0;
    const entry: ProcEntry = { read: () => ++calls };
    const procFs = createProcFs({ cacheTtlMs: 20 });
    procFs.mount("/t", entry);
    await procFs.read("/t");
    await Bun.sleep(40);
    await procFs.read("/t");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --cwd packages/lib/agent-procfs test`
Expected: 13 fails (`createProcFs` not exported).

- [ ] **Step 3: Implement `procfs-impl.ts`**

Port from `archive/v1/packages/observability/agent-procfs/src/procfs-impl.ts`. Adapt to L0 contract `ProcFs` from `@koi/core`. Skeleton:

```typescript
import type { ProcEntry, ProcFs, WritableProcEntry } from "@koi/core";

export interface ProcFsConfig {
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 1_000;

function isWritable(e: ProcEntry | WritableProcEntry): e is WritableProcEntry {
  return typeof (e as WritableProcEntry).write === "function";
}

export function createProcFs(config: ProcFsConfig = {}): ProcFs {
  const ttl = config.cacheTtlMs ?? DEFAULT_TTL_MS;
  const entries = new Map<string, ProcEntry | WritableProcEntry>();
  const cache = new Map<string, CacheEntry>();

  function invalidate(path: string): void {
    cache.delete(path);
  }

  return {
    mount(path, entry) {
      entries.set(path, entry);
      invalidate(path);
    },
    unmount(path) {
      entries.delete(path);
      invalidate(path);
    },
    async read(path) {
      const entry = entries.get(path);
      if (!entry) {
        throw new Error(`NOT_FOUND: no entry mounted at ${path}`);
      }
      if (ttl > 0) {
        const cached = cache.get(path);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.value;
        }
      }
      const value = await entry.read();
      if (ttl > 0) {
        cache.set(path, { value, expiresAt: Date.now() + ttl });
      }
      return value;
    },
    async write(path, value) {
      const entry = entries.get(path);
      if (!entry) {
        throw new Error(`NOT_FOUND: no entry mounted at ${path}`);
      }
      if (!isWritable(entry)) {
        throw new Error(`not writable: ${path} is a read-only entry`);
      }
      await entry.write(value);
      invalidate(path);
    },
    async list(path) {
      const entry = entries.get(path);
      if (entry?.list) return await entry.list();
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const next = rest.split("/")[0];
          if (next) seen.add(next);
        }
      }
      return [...seen];
    },
    entries() {
      return [...entries.keys()];
    },
  };
}
```

- [ ] **Step 4: Re-run tests**

Run: `bun --cwd packages/lib/agent-procfs test`
Expected: 13 pass.

- [ ] **Step 5: Add `ProcFsConfig` + `createProcFs` to `src/index.ts`**

```typescript
export { createProcFs } from "./procfs-impl.js";
export type { ProcFsConfig } from "./procfs-impl.js";
```

- [ ] **Step 6: Verify typecheck + build + lint**

Run: `bun --cwd packages/lib/agent-procfs run typecheck && bun --cwd packages/lib/agent-procfs run build && bun --cwd packages/lib/agent-procfs run lint`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/agent-procfs/src/procfs-impl.ts packages/lib/agent-procfs/src/procfs-impl.test.ts packages/lib/agent-procfs/src/index.ts
git commit -m "feat(agent-procfs): createProcFs with TTL microcache"
```

---

## Task 3 — Entry factories (the 7 entries)

**Spec section:** "Entries" (`docs/L2/agent-procfs.md` §Entries).
**V1 reference:** `archive/v1/packages/observability/agent-procfs/src/entry-definitions.ts`.

**Files:**
- Create: `packages/lib/agent-procfs/src/entries/{status,tools,middleware,children,config,env,metrics}.ts`
- Create: `packages/lib/agent-procfs/src/entries/index.ts` — `buildAgentEntries(agent, registry)`
- Create: `packages/lib/agent-procfs/src/entries/index.test.ts`

Each entry factory takes the agent identity + dependencies and returns a `ProcEntry` (or `WritableProcEntry` for `metrics`). Read functions are pure thunks over current state — no caching at the factory level (caching happens in `ProcFs`).

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
// import { buildAgentEntries } from "./index.js";  // not yet exported
import type { Agent, AgentRegistry } from "@koi/core";

// Minimal fake agent + registry — enough to exercise each entry.
function makeFakeAgent(/* fields */): Agent { /* ... */ throw new Error("TODO"); }
function makeFakeRegistry(): AgentRegistry { /* ... */ throw new Error("TODO"); }

describe("buildAgentEntries", () => {
  test("status returns { pid, state }", async () => {
    // … see spec §Entries for shape.
  });
  test("tools returns descriptors of attached tools", async () => {});
  test("middleware returns names + hook counts", async () => {});
  test("children filters registry by parentId", async () => {});
  test("config returns manifest config", async () => {});
  test("env returns ENV component values when attached", async () => {});
  test("env returns {} when ENV component absent", async () => {});
  test("metrics is writable; write patches priority via registry.patch", async () => {});
});
```

  Fill in the fake-agent/registry helpers based on `Agent`, `RegistryEntry`, and `AgentRegistry` shapes in `packages/kernel/core/src/{ecs,lifecycle}.ts`. Keep them in this file — do not create test utilities outside the package.

- [ ] **Step 2: Run tests — confirm failure**

Run: `bun --cwd packages/lib/agent-procfs test entries`
Expected: tests fail because `buildAgentEntries` not exported.

- [ ] **Step 3: Implement each entry file**

Port from `archive/v1/packages/observability/agent-procfs/src/entry-definitions.ts`. Each file exports a single factory:

```typescript
// entries/status.ts
import type { Agent, AgentRegistry, ProcEntry } from "@koi/core";

export function statusEntry(agent: Agent, registry: AgentRegistry): ProcEntry {
  return {
    read: async () => {
      const entry = await registry.lookup(agent.id);
      if (!entry) return undefined;
      return {
        pid: entry.descriptor ?? entry,
        state: entry.phase,
        terminationOutcome: entry.terminationOutcome,
      };
    },
  };
}
```

Apply the analogous pattern for `tools`, `middleware`, `children`, `config`, `env`. For `metrics`:

```typescript
// entries/metrics.ts
import type { Agent, AgentRegistry, WritableProcEntry } from "@koi/core";

export function metricsEntry(agent: Agent, registry: AgentRegistry): WritableProcEntry {
  return {
    read: async () => {
      const entry = await registry.lookup(agent.id);
      return entry ? { priority: entry.priority } : undefined;
    },
    write: async (value) => {
      const v = value as { priority?: number };
      if (typeof v?.priority !== "number") {
        throw new Error("VALIDATION: metrics write requires { priority: number }");
      }
      const result = await registry.patch(agent.id, { priority: v.priority });
      if (!result.ok) throw new Error(`patch failed: ${result.error.message}`);
    },
  };
}
```

For the seven mount paths, define a constant array used by both `buildAgentEntries` and the mounter:

```typescript
// entries/index.ts
import type { Agent, AgentRegistry, ProcEntry, WritableProcEntry } from "@koi/core";
import { statusEntry } from "./status.js";
import { toolsEntry } from "./tools.js";
import { middlewareEntry } from "./middleware.js";
import { childrenEntry } from "./children.js";
import { configEntry } from "./config.js";
import { envEntry } from "./env.js";
import { metricsEntry } from "./metrics.js";

export const ENTRY_NAMES = [
  "status",
  "tools",
  "middleware",
  "children",
  "config",
  "env",
  "metrics",
] as const;

export type EntryName = (typeof ENTRY_NAMES)[number];

export function buildAgentEntries(
  agent: Agent,
  registry: AgentRegistry,
): Readonly<Record<EntryName, ProcEntry | WritableProcEntry>> {
  return {
    status: statusEntry(agent, registry),
    tools: toolsEntry(agent),
    middleware: middlewareEntry(agent),
    children: childrenEntry(agent, registry),
    config: configEntry(agent),
    env: envEntry(agent),
    metrics: metricsEntry(agent, registry),
  };
}
```

  When porting `tools`/`middleware`/`config`/`env`, consult the `Agent` ECS API in `packages/kernel/core/src/ecs.ts` to find the right component tokens and accessors. Adapt v1 if the L0 surface has changed.

- [ ] **Step 4: Run tests — confirm pass**

Run: `bun --cwd packages/lib/agent-procfs test entries`
Expected: all entry tests pass.

- [ ] **Step 5: Add to barrel `src/index.ts`**

```typescript
export { createProcFs } from "./procfs-impl.js";
export type { ProcFsConfig } from "./procfs-impl.js";
export { buildAgentEntries, ENTRY_NAMES } from "./entries/index.js";
export type { EntryName } from "./entries/index.js";
```

- [ ] **Step 6: Typecheck + lint**

Run: `bun --cwd packages/lib/agent-procfs run typecheck && bun --cwd packages/lib/agent-procfs run lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/agent-procfs/src/entries/ packages/lib/agent-procfs/src/index.ts
git commit -m "feat(agent-procfs): 7 entry factories (status/tools/middleware/children/config/env/metrics)"
```

---

## Task 4 — `createAgentMounter()` (registry watcher)

**Spec section:** "Mount on register", "Unmount on deregister", `createAgentMounter` (`docs/L2/agent-procfs.md`).
**V1 reference:** `archive/v1/packages/observability/agent-procfs/src/agent-mounter.ts` and its test.

**Files:**
- Create: `packages/lib/agent-procfs/src/agent-mounter.ts`
- Create: `packages/lib/agent-procfs/src/agent-mounter.test.ts`

- [ ] **Step 1: Write the failing test** — port from v1 test, adapt to L0 contracts.

Required scenarios (one `test()` each):
1. mount on `registered` event mounts all 7 entries at `/agents/<id>/<name>`
2. deregister event unmounts all 7 entries
3. skip mount when `agentProvider(id)` returns `undefined`
4. multiple agents register/deregister in churn — no leaks (count of mounted entries returns to 0 after all deregister)
5. `dispose()` stops watching (post-dispose `registered` event has no effect)
6. existing agents in registry at construction time are mounted retroactively

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createProcFs } from "./procfs-impl.js";
import { createAgentMounter } from "./agent-mounter.js";
// fake registry helper from this same file (same as Task 3)

// Sketch of the first test:
test("registered event mounts all 7 entries", async () => {
  const procFs = createProcFs({ cacheTtlMs: 0 });
  const registry = makeFakeRegistry();
  const a1 = agentId("worker-1");
  const agentMap = new Map([[a1, makeFakeAgent({ id: a1 })]]);
  createAgentMounter({ registry, procFs, agentProvider: (id) => agentMap.get(id) });
  await registry.__emitRegistered({ id: a1 /* … RegistryEntry shape */ });
  const paths = procFs.entries();
  for (const name of ["status", "tools", "middleware", "children", "config", "env", "metrics"]) {
    expect(paths).toContain(`/agents/${a1}/${name}`);
  }
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `bun --cwd packages/lib/agent-procfs test agent-mounter`
Expected: fails (`createAgentMounter` not exported).

- [ ] **Step 3: Implement the mounter**

```typescript
// agent-mounter.ts
import type {
  Agent,
  AgentId,
  AgentRegistry,
  ProcFs,
  RegistryEvent,
} from "@koi/core";
import { ENTRY_NAMES, buildAgentEntries } from "./entries/index.js";

export interface AgentMounterConfig {
  readonly registry: AgentRegistry;
  readonly procFs: ProcFs;
  readonly agentProvider: (id: AgentId) => Agent | undefined;
}

export interface AgentMounter {
  readonly dispose: () => void;
}

function pathFor(agentId: AgentId, name: string): string {
  return `/agents/${agentId}/${name}`;
}

export function createAgentMounter(config: AgentMounterConfig): AgentMounter {
  const { registry, procFs, agentProvider } = config;

  function mountAgent(id: AgentId): void {
    const agent = agentProvider(id);
    if (!agent) return;
    const entries = buildAgentEntries(agent, registry);
    for (const name of ENTRY_NAMES) {
      procFs.mount(pathFor(id, name), entries[name]);
    }
  }

  function unmountAgent(id: AgentId): void {
    for (const name of ENTRY_NAMES) {
      procFs.unmount(pathFor(id, name));
    }
  }

  // Retroactively mount any agents already in the registry.
  Promise.resolve(registry.list()).then((existing) => {
    for (const entry of existing) mountAgent(entry.id);
  });

  const unwatch = registry.watch((event: RegistryEvent) => {
    if (event.kind === "registered") mountAgent(event.entry.id);
    else if (event.kind === "deregistered") unmountAgent(event.agentId);
  });

  return {
    dispose: () => unwatch(),
  };
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `bun --cwd packages/lib/agent-procfs test agent-mounter`
Expected: all mounter tests pass.

- [ ] **Step 5: Export from `src/index.ts`**

```typescript
export { createAgentMounter } from "./agent-mounter.js";
export type { AgentMounter, AgentMounterConfig } from "./agent-mounter.js";
```

- [ ] **Step 6: Run full package suite, typecheck, build, lint**

Run: `bun --cwd packages/lib/agent-procfs test && bun --cwd packages/lib/agent-procfs run typecheck && bun --cwd packages/lib/agent-procfs run build && bun --cwd packages/lib/agent-procfs run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/agent-procfs/
git commit -m "feat(agent-procfs): createAgentMounter watches registry, mounts/unmounts per agent"
```

---

## Task 5 — Layer compliance + repo gates

- [ ] **Step 1: Run repo-wide layer check**

Run: `bun run check:layers`
Expected: exit 0. Should report `@koi/agent-procfs` as L2 and confirm only `@koi/core` import.

- [ ] **Step 2: Run unused-export check**

Run: `bun run check:unused`
Expected: exit 0 (or warnings only on the new package; address any).

- [ ] **Step 3: Run duplicate-block check**

Run: `bun run check:duplicates`
Expected: exit 0.

- [ ] **Step 4: Run repo-wide test**

Run: `bun run test --filter=@koi/agent-procfs`
Expected: 20+ tests pass (procfs + entries + mounter).

- [ ] **Step 5: Commit any docs/CI fixes if surfaced**

```bash
git status
# only commit if any tracked file changed
```

---

## Task 6 — Wire to `@koi/runtime` golden coverage

**Why:** Project rule "Golden Query & Trajectory Rule (every new L2 package)" — every new L2 must be a `@koi/runtime` dependency with golden assertions. See `CLAUDE.md` §Golden.

**Files:**
- Modify: `packages/meta/runtime/package.json` — add `"@koi/agent-procfs": "workspace:*"` to `dependencies`.
- Modify: `packages/meta/runtime/tsconfig.json` — add `{ "path": "../../lib/agent-procfs" }` to `references`.
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts` — add `describe("Golden: @koi/agent-procfs", …)` with 2 LLM-free assertions.

- [ ] **Step 1: Add dep + tsconfig reference**

Edit `packages/meta/runtime/package.json`:

```jsonc
{
  // ...
  "dependencies": {
    // existing deps...
    "@koi/agent-procfs": "workspace:*"
  }
}
```

Edit `packages/meta/runtime/tsconfig.json` references array:

```jsonc
{ "path": "../../lib/agent-procfs" }
```

Run `bun install` after edits.

- [ ] **Step 2: Add golden tests** — append to `golden-replay.test.ts`

```typescript
describe("Golden: @koi/agent-procfs", () => {
  test("createProcFs supports TTL cache + write invalidation", async () => {
    const { createProcFs } = await import("@koi/agent-procfs");
    let calls = 0;
    const procFs = createProcFs({ cacheTtlMs: 1000 });
    procFs.mount("/x", {
      read: () => ++calls,
      write: () => {},
    });
    await procFs.read("/x");
    await procFs.read("/x");
    expect(calls).toBe(1);
    await procFs.write("/x", null);
    await procFs.read("/x");
    expect(calls).toBe(2);
  });

  test("createAgentMounter mounts 7 entries per registered agent", async () => {
    // build a fake registry + agent map, register one agent,
    // assert procFs.entries() contains all 7 paths under /agents/<id>/
    // (use the same fakes from packages/lib/agent-procfs tests, inlined)
  });
});
```

- [ ] **Step 3: Run runtime tests**

Run: `bun --cwd packages/meta/runtime test`
Expected: existing golden tests + 2 new pass.

- [ ] **Step 4: Run orphan + golden checks**

Run: `bun run check:orphans && bun run check:golden-queries`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json packages/meta/runtime/src/__tests__/golden-replay.test.ts
git commit -m "test(runtime): golden coverage for @koi/agent-procfs"
```

---

## Task 7 — PR

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin feat/issue-1378-agent-monitor
gh pr create --title "feat(agent-procfs): /proc-style virtual fs for agent introspection (#1378)" --body "$(cat <<'EOF'
## Summary
- New L2 package `@koi/agent-procfs` per `docs/L2/agent-procfs.md`
- `createProcFs()` with per-path TTL microcache (default 1s)
- `createAgentMounter()` watches `AgentRegistry`, mounts/unmounts 7 entries per agent
- Wired into `@koi/runtime` with 2 golden-replay assertions

Implements part 1 of #1378 (v2 Phase 3-obs-2). Discovery + monitor follow in separate PRs.

## Test plan
- [ ] `bun --cwd packages/lib/agent-procfs test` — ProcFs + entries + mounter
- [ ] `bun run check:layers && bun run check:orphans && bun run check:golden-queries`
- [ ] `bun --cwd packages/meta/runtime test` — golden coverage

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Confirm CI green** before requesting review.
