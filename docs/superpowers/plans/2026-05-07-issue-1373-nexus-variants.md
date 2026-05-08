# Issue #1373 Remaining Nexus Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the remaining v2 scope for issue `#1373` by adding `@koi/scratchpad-nexus` and `@koi/workspace-nexus` on top of `@koi/nexus-client`, with explicit optional local fallback and focused tests.

**Architecture:** Follow the existing `@koi/ipc-nexus` pattern: small public factories, package-local Nexus client modules, poll-based first-pass behavior where needed, and one-way degradation into an injected fallback. `scratchpad-nexus` implements `ScratchpadComponent` directly; `workspace-nexus` implements `WorkspaceBackend` directly so `createWorkspaceProvider()` can use it unchanged.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup ESM builds, `@koi/core`, `@koi/nexus-client`, existing `@koi/scratchpad-local` and `@koi/workspace` contracts as behavior references.

---

## File Map

```text
Create:
  packages/lib/scratchpad-nexus/package.json
  packages/lib/scratchpad-nexus/tsconfig.json
  packages/lib/scratchpad-nexus/tsup.config.ts
  packages/lib/scratchpad-nexus/src/index.ts
  packages/lib/scratchpad-nexus/src/types.ts
  packages/lib/scratchpad-nexus/src/client.ts
  packages/lib/scratchpad-nexus/src/map-entry.ts
  packages/lib/scratchpad-nexus/src/change-tracker.ts
  packages/lib/scratchpad-nexus/src/scratchpad.ts
  packages/lib/scratchpad-nexus/src/scratchpad.test.ts
  packages/lib/scratchpad-nexus/src/__tests__/api-surface.test.ts
  packages/lib/workspace-nexus/package.json
  packages/lib/workspace-nexus/tsconfig.json
  packages/lib/workspace-nexus/tsup.config.ts
  packages/lib/workspace-nexus/src/index.ts
  packages/lib/workspace-nexus/src/types.ts
  packages/lib/workspace-nexus/src/client.ts
  packages/lib/workspace-nexus/src/backend.ts
  packages/lib/workspace-nexus/src/backend.test.ts
  packages/lib/workspace-nexus/src/__tests__/api-surface.test.ts

Modify:
  docs/package-coverage-map.md
  docs/L2/scratchpad-nexus.md
  docs/L2/workspace-nexus.md
```

## Task 1: Scaffold `@koi/scratchpad-nexus`

**Files:**
- Create: `packages/lib/scratchpad-nexus/package.json`
- Create: `packages/lib/scratchpad-nexus/tsconfig.json`
- Create: `packages/lib/scratchpad-nexus/tsup.config.ts`
- Create: `packages/lib/scratchpad-nexus/src/index.ts`
- Create: `packages/lib/scratchpad-nexus/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Write the failing API-surface test**

Create `packages/lib/scratchpad-nexus/src/__tests__/api-surface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

describe("@koi/scratchpad-nexus API surface", () => {
  test("exports createNexusScratchpad", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusScratchpad).toBe("function");
  });
});
```

- [ ] **Step 2: Run the API test to verify it fails**

Run:

```bash
bun test packages/lib/scratchpad-nexus/src/__tests__/api-surface.test.ts
```

Expected: FAIL with module resolution errors because the package does not exist yet.

- [ ] **Step 3: Add the package scaffold**

Create `packages/lib/scratchpad-nexus/package.json`:

```json
{
  "name": "@koi/scratchpad-nexus",
  "description": "Nexus-backed ScratchpadComponent with optional local fallback",
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
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  },
  "koi": {
    "optional": true
  }
}
```

Create `packages/lib/scratchpad-nexus/tsconfig.json`:

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
    { "path": "../nexus-client" }
  ]
}
```

Create `packages/lib/scratchpad-nexus/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

Create `packages/lib/scratchpad-nexus/src/index.ts`:

```ts
export { createNexusScratchpad } from "./scratchpad.js";
export type { NexusScratchpadClient } from "./client.js";
export type {
  NexusScratchpadConfig,
  NexusScratchpadEntryRecord,
  NexusScratchpadListResponse,
  NexusScratchpadWriteResponse,
} from "./types.js";
```

- [ ] **Step 4: Run the API test again**

Run:

```bash
bun test packages/lib/scratchpad-nexus/src/__tests__/api-surface.test.ts
```

Expected: still FAIL, now because `scratchpad.ts` does not exist yet.

- [ ] **Step 5: Commit the scaffold checkpoint**

Run:

```bash
git add packages/lib/scratchpad-nexus
git commit -m "feat: scaffold scratchpad nexus package"
```

Expected: commit succeeds with only the new package scaffold files staged.

## Task 2: Add failing `scratchpad-nexus` behavior tests and RPC types

**Files:**
- Create: `packages/lib/scratchpad-nexus/src/scratchpad.test.ts`
- Create: `packages/lib/scratchpad-nexus/src/types.ts`
- Create: `packages/lib/scratchpad-nexus/src/client.ts`

- [ ] **Step 1: Write the failing behavior tests**

Create `packages/lib/scratchpad-nexus/src/scratchpad.test.ts` with these initial tests:

```ts
import { describe, expect, test } from "bun:test";
import type { KoiError, Result, ScratchpadComponent } from "@koi/core";
import { agentGroupId, agentId, scratchpadPath } from "@koi/core";
import { createLocalScratchpad } from "@koi/scratchpad-local";
import type { NexusTransport } from "@koi/nexus-client";

function createHealthyTransport(call: NexusTransport["call"]): NexusTransport {
  return {
    kind: "http",
    call,
    health: async () => ({
      ok: true,
      value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
    }),
    close: () => {},
  };
}

function createFallbackScratchpad(): ScratchpadComponent {
  return createLocalScratchpad({
    groupId: agentGroupId("group-a"),
    authorId: agentId("agent-a"),
  });
}

describe("createNexusScratchpad", () => {
  test("writes and reads an entry through Nexus", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    let stored: { content: string; generation: number } | null = null;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "scratchpad.write") {
          stored = { content: "hello", generation: 1 };
          return {
            ok: true,
            value: { path: "notes.txt", generation: 1, sizeBytes: 5 } as T,
          };
        }
        if (method === "scratchpad.read") {
          return {
            ok: true,
            value: {
              entry: {
                path: "notes.txt",
                content: stored?.content ?? "hello",
                generation: stored?.generation ?? 1,
                groupId: "group-a",
                authorId: "agent-a",
                createdAt: "2026-05-07T00:00:00.000Z",
                updatedAt: "2026-05-07T00:00:00.000Z",
                sizeBytes: 5,
              },
            } as T,
          };
        }
        return { ok: false, error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false } };
      }),
    });

    const writeResult = await scratchpad.write({
      path: scratchpadPath("notes.txt"),
      content: "hello",
    });
    expect(writeResult.ok).toBe(true);

    const readResult = await scratchpad.read(scratchpadPath("notes.txt"));
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.value.content).toBe("hello");
  });

  test("uses fallback when health check fails", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      fallback: createFallbackScratchpad(),
      transport: {
        kind: "http",
        call: async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        health: async () => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        close: () => {},
      },
    });

    const result = await scratchpad.write({
      path: scratchpadPath("fallback.txt"),
      content: "ok",
    });
    expect(result.ok).toBe(true);
  });

  test("runtime failure degrades permanently to fallback", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    let shouldFail = true;
    const fallback = createFallbackScratchpad();
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      fallback,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "scratchpad.write" && shouldFail) {
          shouldFail = false;
          return { ok: false, error: { code: "EXTERNAL", message: "down", retryable: false } };
        }
        return {
          ok: true,
          value: { path: "ignored.txt", generation: 1, sizeBytes: 2 } as T,
        };
      }),
    });

    const first = await scratchpad.write({ path: scratchpadPath("a.txt"), content: "aa" });
    expect(first.ok).toBe(true);

    const second = await scratchpad.write({ path: scratchpadPath("b.txt"), content: "bb" });
    expect(second.ok).toBe(true);

    const listed = await scratchpad.list();
    expect(listed.some((entry) => entry.path === scratchpadPath("b.txt"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the scratchpad tests to verify they fail**

Run:

```bash
bun test packages/lib/scratchpad-nexus/src/scratchpad.test.ts
```

Expected: FAIL because `types.ts`, `client.ts`, and `scratchpad.ts` are missing.

- [ ] **Step 3: Add the transport-facing types**

Create `packages/lib/scratchpad-nexus/src/types.ts`:

```ts
import type {
  AgentGroupId,
  AgentId,
  ScratchpadComponent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusScratchpadConfig {
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: ScratchpadComponent | undefined;
  readonly methodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface NexusScratchpadEntryRecord extends Omit<ScratchpadEntry, "path" | "groupId" | "authorId"> {
  readonly path: string;
  readonly groupId: string;
  readonly authorId: string;
}

export interface NexusScratchpadWriteResponse {
  readonly path: string;
  readonly generation: number;
  readonly sizeBytes: number;
}

export interface NexusScratchpadReadResponse {
  readonly entry: NexusScratchpadEntryRecord;
}

export interface NexusScratchpadListResponse {
  readonly entries: readonly (Omit<ScratchpadEntrySummary, "path" | "groupId" | "authorId"> & {
    readonly path: string;
    readonly groupId: string;
    readonly authorId: string;
  })[];
}
```

Create `packages/lib/scratchpad-nexus/src/client.ts`:

```ts
import type { Result, ScratchpadWriteInput } from "@koi/core";
import type { KoiError, ScratchpadFilter } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type {
  NexusScratchpadListResponse,
  NexusScratchpadReadResponse,
  NexusScratchpadWriteResponse,
} from "./types.js";

export interface NexusScratchpadClient {
  readonly write: (groupId: string, authorId: string, input: ScratchpadWriteInput) => Promise<Result<NexusScratchpadWriteResponse, KoiError>>;
  readonly read: (groupId: string, path: string) => Promise<Result<NexusScratchpadReadResponse, KoiError>>;
  readonly list: (groupId: string, filter: ScratchpadFilter | undefined, limit: number) => Promise<Result<NexusScratchpadListResponse, KoiError>>;
  readonly delete: (groupId: string, authorId: string, path: string) => Promise<Result<void, KoiError>>;
}

export function createNexusScratchpadClient(
  transport: NexusTransport,
  prefix: string,
): NexusScratchpadClient {
  return {
    write: (groupId, authorId, input) =>
      transport.call<NexusScratchpadWriteResponse>(`${prefix}.write`, {
        groupId,
        authorId,
        path: input.path,
        content: input.content,
        expectedGeneration: input.expectedGeneration,
        ttlSeconds: input.ttlSeconds,
        metadata: input.metadata,
      }),
    read: (groupId, path) =>
      transport.call<NexusScratchpadReadResponse>(`${prefix}.read`, { groupId, path }),
    list: (groupId, filter, limit) =>
      transport.call<NexusScratchpadListResponse>(`${prefix}.list`, { groupId, filter, limit }),
    delete: async (groupId, authorId, path) => {
      const result = await transport.call<{ readonly ok: true }>(`${prefix}.delete`, {
        groupId,
        authorId,
        path,
      });
      return result.ok ? { ok: true, value: undefined } : result;
    },
  };
}
```

- [ ] **Step 4: Run the tests again**

Run:

```bash
bun test packages/lib/scratchpad-nexus/src/scratchpad.test.ts
```

Expected: FAIL because `scratchpad.ts` and mapping helpers still do not exist.

## Task 3: Implement `@koi/scratchpad-nexus`

**Files:**
- Create: `packages/lib/scratchpad-nexus/src/map-entry.ts`
- Create: `packages/lib/scratchpad-nexus/src/change-tracker.ts`
- Create: `packages/lib/scratchpad-nexus/src/scratchpad.ts`
- Modify: `packages/lib/scratchpad-nexus/src/index.ts`
- Modify: `packages/lib/scratchpad-nexus/src/scratchpad.test.ts`

- [ ] **Step 1: Add mapping helpers**

Create `packages/lib/scratchpad-nexus/src/map-entry.ts`:

```ts
import { agentGroupId, agentId, scratchpadPath, type ScratchpadEntry, type ScratchpadEntrySummary } from "@koi/core";
import type { NexusScratchpadEntryRecord, NexusScratchpadListResponse } from "./types.js";

export function mapEntry(record: NexusScratchpadEntryRecord): ScratchpadEntry {
  return {
    ...record,
    path: scratchpadPath(record.path),
    groupId: agentGroupId(record.groupId),
    authorId: agentId(record.authorId),
  };
}

export function mapSummaries(response: NexusScratchpadListResponse): readonly ScratchpadEntrySummary[] {
  return response.entries.map((entry) => ({
    ...entry,
    path: scratchpadPath(entry.path),
    groupId: agentGroupId(entry.groupId),
    authorId: agentId(entry.authorId),
  }));
}
```

Create `packages/lib/scratchpad-nexus/src/change-tracker.ts`:

```ts
import type { ScratchpadChangeEvent, ScratchpadEntrySummary } from "@koi/core";

export interface ChangeTracker {
  readonly nextEvents: (entries: readonly ScratchpadEntrySummary[]) => readonly ScratchpadChangeEvent[];
  readonly clear: () => void;
}

export function createChangeTracker(groupId: string): ChangeTracker {
  let seen = new Map<string, number>();

  return {
    nextEvents(entries) {
      const events: ScratchpadChangeEvent[] = [];
      const nextSeen = new Map<string, number>();

      for (const entry of entries) {
        nextSeen.set(entry.path, entry.generation);
        const prior = seen.get(entry.path);
        if (prior === entry.generation) continue;
        events.push({
          kind: "written",
          path: entry.path,
          generation: entry.generation,
          authorId: entry.authorId,
          groupId: entry.groupId,
          timestamp: entry.updatedAt,
        });
      }

      seen = nextSeen;
      return events;
    },
    clear() {
      seen = new Map();
    },
  };
}
```

- [ ] **Step 2: Implement the component**

Create `packages/lib/scratchpad-nexus/src/scratchpad.ts`:

```ts
import type {
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadComponent,
  ScratchpadFilter,
  ScratchpadPath,
  ScratchpadWriteInput,
  ScratchpadWriteResult,
} from "@koi/core";
import { scratchpadPath } from "@koi/core";
import { createNexusScratchpadClient } from "./client.js";
import { createChangeTracker } from "./change-tracker.js";
import { mapEntry, mapSummaries } from "./map-entry.js";
import type { NexusScratchpadConfig } from "./types.js";

const DEFAULT_PREFIX = "scratchpad";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function createNexusScratchpad(config: NexusScratchpadConfig): Promise<ScratchpadComponent> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;
  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) return config.fallback;
  }

  const client = createNexusScratchpadClient(config.transport, prefix);
  const tracker = createChangeTracker(config.groupId as string);
  const subscribers = new Set<(event: ScratchpadChangeEvent) => void>();
  const state = {
    degraded: false,
    closed: false,
    timer: null as ReturnType<typeof setInterval> | null,
  };

  async function degradeOrReturn<T>(result: Result<T, KoiError>): Promise<Result<T, KoiError>> {
    if (result.ok || config.fallback === undefined) return result;
    state.degraded = true;
    if (state.timer !== null) clearInterval(state.timer);
    return result;
  }

  async function poll(): Promise<void> {
    if (state.degraded || state.closed) return;
    const listed = await client.list(config.groupId as string, undefined, config.pageSize ?? DEFAULT_PAGE_SIZE);
    if (!listed.ok) {
      if (config.fallback !== undefined) state.degraded = true;
      return;
    }
    const events = tracker.nextEvents(mapSummaries(listed.value));
    for (const event of events) {
      for (const subscriber of subscribers) subscriber(event);
    }
  }

  function ensurePolling(): void {
    if (state.timer !== null || subscribers.size === 0 || state.degraded || state.closed) return;
    state.timer = setInterval(() => void poll(), config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  return {
    write: async (input: ScratchpadWriteInput): Promise<Result<ScratchpadWriteResult, KoiError>> => {
      if (state.degraded && config.fallback !== undefined) return config.fallback.write(input);
      const result = await client.write(config.groupId as string, config.authorId as string, input);
      if (!result.ok && config.fallback !== undefined) {
        state.degraded = true;
        return config.fallback.write(input);
      }
      return result.ok
        ? {
            ok: true,
            value: {
              path: scratchpadPath(result.value.path),
              generation: result.value.generation,
              sizeBytes: result.value.sizeBytes,
            },
          }
        : result;
    },
    read: async (path: ScratchpadPath) => {
      if (state.degraded && config.fallback !== undefined) return config.fallback.read(path);
      const result = await client.read(config.groupId as string, path as string);
      if (!result.ok && config.fallback !== undefined) {
        state.degraded = true;
        return config.fallback.read(path);
      }
      return result.ok ? { ok: true, value: mapEntry(result.value.entry) } : result;
    },
    list: async (filter?: ScratchpadFilter) => {
      if (state.degraded && config.fallback !== undefined) return config.fallback.list(filter);
      const result = await client.list(
        config.groupId as string,
        filter,
        filter?.limit ?? config.pageSize ?? DEFAULT_PAGE_SIZE,
      );
      if (!result.ok) {
        if (config.fallback !== undefined) {
          state.degraded = true;
          return config.fallback.list(filter);
        }
        return [];
      }
      return mapSummaries(result.value);
    },
    delete: async (path: ScratchpadPath) => {
      if (state.degraded && config.fallback !== undefined) return config.fallback.delete(path);
      const result = await client.delete(config.groupId as string, config.authorId as string, path as string);
      if (!result.ok && config.fallback !== undefined) {
        state.degraded = true;
        return config.fallback.delete(path);
      }
      return result;
    },
    flush: async () => {
      if (state.degraded && config.fallback !== undefined) {
        await config.fallback.flush();
        return;
      }
      tracker.clear();
    },
    onChange: (handler) => {
      if (state.degraded && config.fallback !== undefined) return config.fallback.onChange(handler);
      subscribers.add(handler);
      ensurePolling();
      void poll();
      return () => {
        subscribers.delete(handler);
        if (subscribers.size === 0 && state.timer !== null) {
          clearInterval(state.timer);
          state.timer = null;
        }
      };
    },
  };
}
```

- [ ] **Step 3: Add the missing polling test**

Append this test to `packages/lib/scratchpad-nexus/src/scratchpad.test.ts`:

```ts
test("onChange emits unseen writes once", async () => {
  const { createNexusScratchpad } = await import("./index.js");

  let calls = 0;
  const scratchpad = await createNexusScratchpad({
    groupId: agentGroupId("group-a"),
    authorId: agentId("agent-a"),
    pollIntervalMs: 5,
    transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
      if (method !== "scratchpad.list") {
        return { ok: false, error: { code: "EXTERNAL", message: "unexpected", retryable: false } };
      }
      calls += 1;
      return {
        ok: true,
        value: {
          entries: [
            {
              path: "shared.txt",
              generation: calls === 1 ? 1 : 2,
              groupId: "group-a",
              authorId: "agent-a",
              createdAt: "2026-05-07T00:00:00.000Z",
              updatedAt: "2026-05-07T00:00:00.000Z",
              sizeBytes: 6,
            },
          ],
        } as T,
      };
    }),
  });

  const seen: number[] = [];
  const unsubscribe = scratchpad.onChange((event) => seen.push(event.generation));
  await Bun.sleep(25);
  unsubscribe();

  expect(seen).toContain(1);
  expect(seen).toContain(2);
});
```

- [ ] **Step 4: Run the scratchpad package tests**

Run:

```bash
bun test packages/lib/scratchpad-nexus/src
```

Expected: PASS for the API-surface and scratchpad behavior tests.

- [ ] **Step 5: Commit the scratchpad implementation**

Run:

```bash
git add packages/lib/scratchpad-nexus
git commit -m "feat: add nexus scratchpad backend"
```

Expected: commit succeeds with only `scratchpad-nexus` changes.

## Task 4: Scaffold and test-drive `@koi/workspace-nexus`

**Files:**
- Create: `packages/lib/workspace-nexus/package.json`
- Create: `packages/lib/workspace-nexus/tsconfig.json`
- Create: `packages/lib/workspace-nexus/tsup.config.ts`
- Create: `packages/lib/workspace-nexus/src/index.ts`
- Create: `packages/lib/workspace-nexus/src/__tests__/api-surface.test.ts`
- Create: `packages/lib/workspace-nexus/src/backend.test.ts`
- Create: `packages/lib/workspace-nexus/src/types.ts`
- Create: `packages/lib/workspace-nexus/src/client.ts`

- [ ] **Step 1: Write the failing API-surface and behavior tests**

Create `packages/lib/workspace-nexus/src/__tests__/api-surface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

describe("@koi/workspace-nexus API surface", () => {
  test("exports createNexusWorkspaceBackend", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusWorkspaceBackend).toBe("function");
  });
});
```

Create `packages/lib/workspace-nexus/src/backend.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { KoiError, Result, WorkspaceBackend } from "@koi/core";
import { agentId, workspaceId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createWorkspaceProvider } from "@koi/workspace";

function createHealthyTransport(call: NexusTransport["call"]): NexusTransport {
  return {
    kind: "http",
    call,
    health: async () => ({
      ok: true,
      value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
    }),
    close: () => {},
  };
}

function createFallbackBackend(): WorkspaceBackend {
  return {
    name: "fallback",
    isSandboxed: false,
    create: async () => ({
      ok: true,
      value: {
        id: workspaceId("fallback-ws"),
        path: "/tmp/fallback-ws",
        createdAt: 1,
        metadata: {},
      },
    }),
    dispose: async () => ({ ok: true, value: undefined }),
    isHealthy: async () => true,
  };
}

describe("createNexusWorkspaceBackend", () => {
  test("creates and disposes a workspace through Nexus", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: true,
            value: {
              workspace: {
                id: "ws-1",
                path: "/tmp/ws-1",
                createdAt: 1,
                metadata: {},
              },
            } as T,
          };
        }
        if (method === "workspace.dispose") {
          return { ok: true, value: { ok: true } as T };
        }
        if (method === "workspace.health") {
          return { ok: true, value: { healthy: true } as T };
        }
        return { ok: false, error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false } };
      }),
    });

    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.id).toBe(workspaceId("ws-1"));
      expect(await backend.isHealthy(created.value.id)).toBe(true);
      const disposed = await backend.dispose(created.value.id);
      expect(disposed.ok).toBe(true);
    }
  });

  test("uses fallback backend when health check fails", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      fallback: createFallbackBackend(),
      transport: {
        kind: "http",
        call: async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        health: async () => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        close: () => {},
      },
    });

    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.id).toBe(workspaceId("fallback-ws"));
  });

  test("works with createWorkspaceProvider", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: true,
            value: {
              workspace: {
                id: "ws-provider",
                path: "/tmp/ws-provider",
                createdAt: 1,
                metadata: {},
              },
            } as T,
          };
        }
        if (method === "workspace.health") return { ok: true, value: { healthy: true } as T };
        if (method === "workspace.dispose") return { ok: true, value: { ok: true } as T };
        return { ok: true, value: { workspaces: [] } as T };
      }),
    });

    const provider = createWorkspaceProvider({ backend });
    const result = await provider.attach({
      pid: { id: agentId("agent-a"), run: "r1", session: "s1" },
      lifecycle: "active",
      startedAt: Date.now(),
      messageCount: 0,
    });
    expect(result.components.size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the workspace tests to verify they fail**

Run:

```bash
bun test packages/lib/workspace-nexus/src
```

Expected: FAIL because the package files do not exist yet.

- [ ] **Step 3: Add the package scaffold and Nexus client types**

Create `packages/lib/workspace-nexus/package.json` and `tsconfig.json` mirroring `ipc-nexus`, but with dependencies on `@koi/core`, `@koi/nexus-client`, and `@koi/workspace`.

Create `packages/lib/workspace-nexus/src/index.ts`:

```ts
export { createNexusWorkspaceBackend } from "./backend.js";
export type { NexusWorkspaceBackendClient } from "./client.js";
export type {
  NexusWorkspaceBackendConfig,
  NexusWorkspaceHealthResponse,
  NexusWorkspaceRecord,
} from "./types.js";
```

Create `packages/lib/workspace-nexus/src/types.ts`:

```ts
import type { WorkspaceBackend } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusWorkspaceBackendConfig {
  readonly transport: NexusTransport;
  readonly fallback?: WorkspaceBackend | undefined;
  readonly methodPrefix?: string | undefined;
  readonly basePath?: string | undefined;
}

export interface NexusWorkspaceRecord {
  readonly id: string;
  readonly path: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface NexusWorkspaceCreateResponse {
  readonly workspace: NexusWorkspaceRecord;
}

export interface NexusWorkspaceHealthResponse {
  readonly healthy: boolean;
}
```

Create `packages/lib/workspace-nexus/src/client.ts`:

```ts
import type { AgentId, KoiError, ResolvedWorkspaceConfig, Result, WorkspaceId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type {
  NexusWorkspaceCreateResponse,
  NexusWorkspaceHealthResponse,
} from "./types.js";

export interface NexusWorkspaceBackendClient {
  readonly create: (agentId: AgentId, config: ResolvedWorkspaceConfig) => Promise<Result<NexusWorkspaceCreateResponse, KoiError>>;
  readonly dispose: (wsId: WorkspaceId) => Promise<Result<void, KoiError>>;
  readonly health: (wsId: WorkspaceId) => Promise<Result<NexusWorkspaceHealthResponse, KoiError>>;
}

export function createNexusWorkspaceBackendClient(
  transport: NexusTransport,
  prefix: string,
): NexusWorkspaceBackendClient {
  return {
    create: (agentId, config) => transport.call(`${prefix}.create`, { agentId, config }),
    dispose: async (wsId) => {
      const result = await transport.call<{ readonly ok: true }>(`${prefix}.dispose`, { workspaceId: wsId });
      return result.ok ? { ok: true, value: undefined } : result;
    },
    health: (wsId) => transport.call(`${prefix}.health`, { workspaceId: wsId }),
  };
}
```

- [ ] **Step 4: Run the workspace tests again**

Run:

```bash
bun test packages/lib/workspace-nexus/src
```

Expected: FAIL because `backend.ts` does not exist yet.

## Task 5: Implement `@koi/workspace-nexus`

**Files:**
- Create: `packages/lib/workspace-nexus/src/backend.ts`
- Modify: `packages/lib/workspace-nexus/src/index.ts`
- Modify: `packages/lib/workspace-nexus/src/backend.test.ts`

- [ ] **Step 1: Implement the backend**

Create `packages/lib/workspace-nexus/src/backend.ts`:

```ts
import type { AgentId, KoiError, ResolvedWorkspaceConfig, Result, WorkspaceBackend, WorkspaceId, WorkspaceInfo } from "@koi/core";
import { workspaceId } from "@koi/core";
import { createNexusWorkspaceBackendClient } from "./client.js";
import type { NexusWorkspaceBackendConfig } from "./types.js";

const DEFAULT_PREFIX = "workspace";

function mapWorkspace(record: { id: string; path: string; createdAt: number; metadata: Readonly<Record<string, string>> }): WorkspaceInfo {
  return {
    id: workspaceId(record.id),
    path: record.path,
    createdAt: record.createdAt,
    metadata: record.metadata,
  };
}

export async function createNexusWorkspaceBackend(
  config: NexusWorkspaceBackendConfig,
): Promise<WorkspaceBackend> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;
  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) return config.fallback;
  }

  const client = createNexusWorkspaceBackendClient(config.transport, prefix);
  let degraded = false;

  return {
    name: "workspace-nexus",
    isSandboxed: false,
    create: async (agentId: AgentId, resolved: ResolvedWorkspaceConfig): Promise<Result<WorkspaceInfo, KoiError>> => {
      if (degraded && config.fallback !== undefined) return config.fallback.create(agentId, resolved);
      const result = await client.create(agentId, resolved);
      if (!result.ok && config.fallback !== undefined) {
        degraded = true;
        return config.fallback.create(agentId, resolved);
      }
      return result.ok ? { ok: true, value: mapWorkspace(result.value.workspace) } : result;
    },
    dispose: async (wsId: WorkspaceId) => {
      if (degraded && config.fallback !== undefined) return config.fallback.dispose(wsId);
      const result = await client.dispose(wsId);
      if (!result.ok && config.fallback !== undefined) {
        degraded = true;
        return config.fallback.dispose(wsId);
      }
      return result;
    },
    isHealthy: async (wsId: WorkspaceId) => {
      if (degraded && config.fallback !== undefined) return config.fallback.isHealthy(wsId);
      const result = await client.health(wsId);
      if (!result.ok) {
        if (config.fallback !== undefined) {
          degraded = true;
          return config.fallback.isHealthy(wsId);
        }
        return false;
      }
      return result.value.healthy;
    },
  };
}
```

- [ ] **Step 2: Add the sticky degradation test**

Append this test to `packages/lib/workspace-nexus/src/backend.test.ts`:

```ts
test("degraded mode is sticky after runtime failure", async () => {
  const { createNexusWorkspaceBackend } = await import("./index.js");

  let createShouldFail = true;
  const backend = await createNexusWorkspaceBackend({
    fallback: createFallbackBackend(),
    transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
      if (method === "workspace.create" && createShouldFail) {
        createShouldFail = false;
        return { ok: false, error: { code: "EXTERNAL", message: "down", retryable: false } };
      }
      return {
        ok: true,
        value: {
          workspace: {
            id: "ws-ignored",
            path: "/tmp/ws-ignored",
            createdAt: 1,
            metadata: {},
          },
        } as T,
      };
    }),
  });

  const first = await backend.create(agentId("agent-a"), {
    cleanupPolicy: "on_success",
    cleanupTimeoutMs: 5_000,
  });
  expect(first.ok).toBe(true);

  const second = await backend.create(agentId("agent-a"), {
    cleanupPolicy: "on_success",
    cleanupTimeoutMs: 5_000,
  });
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.value.id).toBe(workspaceId("fallback-ws"));
});
```

- [ ] **Step 3: Run the workspace tests**

Run:

```bash
bun test packages/lib/workspace-nexus/src
```

Expected: PASS for API-surface, backend, fallback, and provider-compatibility tests.

- [ ] **Step 4: Commit the workspace implementation**

Run:

```bash
git add packages/lib/workspace-nexus
git commit -m "feat: add nexus workspace backend"
```

Expected: commit succeeds with only `workspace-nexus` changes.

## Task 6: Refresh docs and run final verification

**Files:**
- Modify: `docs/package-coverage-map.md`
- Modify: `docs/L2/scratchpad-nexus.md`
- Modify: `docs/L2/workspace-nexus.md`

- [ ] **Step 1: Update package docs to match the v2 implementations**

Edit `docs/L2/scratchpad-nexus.md` so it documents the v2 package at `packages/lib/scratchpad-nexus`, the `createNexusScratchpad()` factory, polling-based `onChange()`, and explicit optional fallback to another `ScratchpadComponent`.

Edit `docs/L2/workspace-nexus.md` so it documents the v2 package at `packages/lib/workspace-nexus`, the `createNexusWorkspaceBackend()` factory, provider compatibility through `WorkspaceBackend`, and explicit optional fallback to another backend.

Edit `docs/package-coverage-map.md` so:

- `@koi/scratchpad-nexus` points to `packages/lib/scratchpad-nexus`
- `@koi/workspace-nexus` points to `packages/lib/workspace-nexus`
- both descriptions reflect the implemented v2 scope rather than the archived package layout

- [ ] **Step 2: Run focused verification**

Run:

```bash
bun test packages/lib/scratchpad-nexus/src
bun test packages/lib/workspace-nexus/src
```

Expected: all tests in both new packages PASS.

- [ ] **Step 3: Run lint on the touched packages and docs**

Run:

```bash
bunx biome check packages/lib/scratchpad-nexus packages/lib/workspace-nexus docs/L2/scratchpad-nexus.md docs/L2/workspace-nexus.md docs/package-coverage-map.md
```

Expected: PASS with no diagnostics.

- [ ] **Step 4: Commit docs and verification-ready state**

Run:

```bash
git add docs/package-coverage-map.md docs/L2/scratchpad-nexus.md docs/L2/workspace-nexus.md
git commit -m "docs: refresh nexus variant package docs"
```

Expected: commit succeeds with only doc updates staged.

- [ ] **Step 5: Final pre-handoff check**

Run:

```bash
git status --short
```

Expected: empty output.

## Self-Review

- Spec coverage: this plan covers both remaining packages in the approved spec, including fallback, degradation, package docs, and focused tests.
- Placeholder scan: no `TODO`, `TBD`, or “implement later” placeholders remain.
- Type consistency: package names, factory names, and core contract types are consistent with the approved spec and current v2 naming.
