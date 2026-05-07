# Issue #1373 `@koi/ipc-nexus` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first slice of issue `#1373` by adding `@koi/ipc-nexus`, a Nexus-backed `MailboxComponent` with explicit optional fallback to a local mailbox.

**Architecture:** Build a thin adapter over `NexusTransport` from `@koi/nexus-client`. Keep Nexus RPC knowledge inside a tiny client module, use polling rather than SSE in the first pass, and degrade to an injected fallback mailbox when Nexus health is unavailable at creation time or Nexus operations fail later.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup ESM-only builds, injected fake `NexusTransport` for tests.

---

## Spec Reference

Read [`docs/superpowers/specs/2026-05-06-issue-1373-nexus-variants-design.md`](/Users/sophiawj/private/koi/.worktrees/issue-1373-nexus-variants/docs/superpowers/specs/2026-05-06-issue-1373-nexus-variants-design.md) before starting. This plan implements **Phase 1 only**.

---

## File Map

```text
Create:
  packages/lib/ipc-nexus/package.json
  packages/lib/ipc-nexus/tsconfig.json
  packages/lib/ipc-nexus/tsup.config.ts
  packages/lib/ipc-nexus/src/index.ts
  packages/lib/ipc-nexus/src/types.ts
  packages/lib/ipc-nexus/src/client.ts
  packages/lib/ipc-nexus/src/map-message.ts
  packages/lib/ipc-nexus/src/seen-set.ts
  packages/lib/ipc-nexus/src/mailbox.ts
  packages/lib/ipc-nexus/src/mailbox.test.ts
  packages/lib/ipc-nexus/src/__tests__/api-surface.test.ts
  docs/L2/ipc-nexus.md

Modify:
  package.json
  tsconfig.json
  docs/package-coverage-map.md
```

---

### Task 1: Scaffold `@koi/ipc-nexus`

**Files:**
- Create: `packages/lib/ipc-nexus/package.json`
- Create: `packages/lib/ipc-nexus/tsconfig.json`
- Create: `packages/lib/ipc-nexus/tsup.config.ts`
- Create: `packages/lib/ipc-nexus/src/index.ts`

- [ ] **Step 1: Write the failing API-surface test**

Create `packages/lib/ipc-nexus/src/__tests__/api-surface.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("@koi/ipc-nexus API surface", () => {
  test("exports createNexusMailbox", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.createNexusMailbox).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test packages/lib/ipc-nexus/src/__tests__/api-surface.test.ts
```

Expected: module resolution failure because the package does not exist yet.

- [ ] **Step 3: Add the package scaffold**

Create `packages/lib/ipc-nexus/package.json`:

```json
{
  "name": "@koi/ipc-nexus",
  "description": "Nexus-backed MailboxComponent with optional local fallback",
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
    "@koi/core": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  }
}
```

Create `packages/lib/ipc-nexus/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../nexus-client" }
  ]
}
```

Create `packages/lib/ipc-nexus/tsup.config.ts`:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
});
```

Create `packages/lib/ipc-nexus/src/index.ts`:

```typescript
export type { NexusMailboxConfig } from "./mailbox.js";
export { createNexusMailbox } from "./mailbox.js";
```

- [ ] **Step 4: Run the API-surface test again**

Run:

```bash
bun test packages/lib/ipc-nexus/src/__tests__/api-surface.test.ts
```

Expected: still failing because `mailbox.ts` is not implemented yet, but the package path now exists.

---

### Task 2: Define the package types and RPC client

**Files:**
- Create: `packages/lib/ipc-nexus/src/types.ts`
- Create: `packages/lib/ipc-nexus/src/client.ts`

- [ ] **Step 1: Write the failing client test**

Create `packages/lib/ipc-nexus/src/mailbox.test.ts` with:

```typescript
import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";

describe("createNexusMailbox", () => {
  test("sends a message through Nexus transport", async () => {
    const { createNexusMailbox } = await import("./index.js");

    const transport = {
      kind: "http" as const,
      call: async () => ({
        ok: true as const,
        value: {
          id: "msg-1",
          from: "agent-a",
          to: "agent-b",
          kind: "request",
          type: "review",
          payload: { text: "check this" },
          createdAt: "2026-05-06T00:00:00.000Z",
        },
      }),
      health: async () => ({
        ok: true as const,
        value: {
          status: "ok" as const,
          version: "1",
          latencyMs: 1,
          probed: ["version"],
        },
      }),
      close: () => {},
    };

    const mailbox = await createNexusMailbox({
      agentId: agentId("agent-a"),
      transport,
    });

    const result = await mailbox.send({
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      type: "review",
      payload: { text: "check this" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("msg-1");
      expect(result.value.to).toBe(agentId("agent-b"));
    }
  });
});
```

- [ ] **Step 2: Run the mailbox test to verify it fails**

Run:

```bash
bun test packages/lib/ipc-nexus/src/mailbox.test.ts
```

Expected: import failure because `mailbox.ts` and supporting types do not exist.

- [ ] **Step 3: Add `types.ts`**

Create `packages/lib/ipc-nexus/src/types.ts`:

```typescript
import type { AgentId, AgentMessage, MailboxComponent } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusMailboxConfig {
  readonly agentId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: MailboxComponent | undefined;
  readonly inboxMethodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
}

export interface NexusEnvelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "request" | "response" | "event" | "cancel";
  readonly correlationId?: string | undefined;
  readonly createdAt: string;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface NexusInboxResponse {
  readonly messages: readonly NexusEnvelope[];
}

export interface SeenMessage extends AgentMessage {
  readonly deliveredAt: string;
}
```

- [ ] **Step 4: Add `client.ts`**

Create `packages/lib/ipc-nexus/src/client.ts`:

```typescript
import type { AgentMessageInput, KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { NexusEnvelope, NexusInboxResponse } from "./types.js";

export interface NexusMailboxClient {
  readonly send: (message: AgentMessageInput) => Promise<Result<NexusEnvelope, KoiError>>;
  readonly list: (
    agentId: string,
    limit: number,
  ) => Promise<Result<readonly NexusEnvelope[], KoiError>>;
}

export function createNexusMailboxClient(
  transport: NexusTransport,
  prefix: string,
): NexusMailboxClient {
  return {
    send: async (message) =>
      transport.call<NexusEnvelope>(`${prefix}.send`, {
        from: message.from,
        to: message.to,
        kind: message.kind,
        correlationId: message.correlationId,
        ttlSeconds: message.ttlSeconds,
        type: message.type,
        payload: message.payload,
        metadata: message.metadata,
      }),
    list: async (agentId, limit) => {
      const result = await transport.call<NexusInboxResponse>(`${prefix}.list`, { agentId, limit });
      return result.ok ? { ok: true, value: result.value.messages } : result;
    },
  };
}
```

- [ ] **Step 5: Run the mailbox test again**

Run:

```bash
bun test packages/lib/ipc-nexus/src/mailbox.test.ts
```

Expected: still failing because message mapping and mailbox behavior are not implemented yet.

---

### Task 3: Implement message mapping and local seen tracking

**Files:**
- Create: `packages/lib/ipc-nexus/src/map-message.ts`
- Create: `packages/lib/ipc-nexus/src/seen-set.ts`

- [ ] **Step 1: Add mapping helpers**

Create `packages/lib/ipc-nexus/src/map-message.ts`:

```typescript
import { agentId, messageId } from "@koi/core";
import type { AgentMessage, AgentMessageInput } from "@koi/core";
import type { NexusEnvelope } from "./types.js";

export function mapAgentMessageToRpc(message: AgentMessageInput): Record<string, unknown> {
  return {
    from: message.from,
    to: message.to,
    kind: message.kind,
    correlationId: message.correlationId,
    ttlSeconds: message.ttlSeconds,
    type: message.type,
    payload: message.payload,
    metadata: message.metadata,
  };
}

export function mapNexusEnvelopeToAgentMessage(envelope: NexusEnvelope): AgentMessage {
  return {
    id: messageId(envelope.id),
    from: agentId(envelope.from),
    to: agentId(envelope.to),
    kind: envelope.kind,
    correlationId:
      envelope.correlationId !== undefined ? messageId(envelope.correlationId) : undefined,
    createdAt: envelope.createdAt,
    ttlSeconds: envelope.ttlSeconds,
    type: envelope.type,
    payload: envelope.payload,
    metadata: envelope.metadata,
  };
}
```

- [ ] **Step 2: Add the seen-message tracker**

Create `packages/lib/ipc-nexus/src/seen-set.ts`:

```typescript
import type { AgentMessage } from "@koi/core";

export interface SeenSet {
  readonly has: (id: string) => boolean;
  readonly add: (message: AgentMessage) => void;
  readonly drain: () => readonly AgentMessage[];
}

export function createSeenSet(): SeenSet {
  const ids = new Set<string>();
  let buffered: readonly AgentMessage[] = [];

  return {
    has: (id) => ids.has(id),
    add: (message) => {
      ids.add(message.id as string);
      buffered = [...buffered, message];
    },
    drain: () => {
      const snapshot = buffered;
      buffered = [];
      return snapshot;
    },
  };
}
```

- [ ] **Step 3: Run the test suite**

Run:

```bash
bun test packages/lib/ipc-nexus/src/mailbox.test.ts
```

Expected: still failing because the mailbox itself is not wired yet.

---

### Task 4: Implement the mailbox with fallback and polling

**Files:**
- Create: `packages/lib/ipc-nexus/src/mailbox.ts`
- Modify: `packages/lib/ipc-nexus/src/index.ts`

- [ ] **Step 1: Implement `mailbox.ts`**

Create `packages/lib/ipc-nexus/src/mailbox.ts`:

```typescript
import type { AgentMessage, MailboxComponent } from "@koi/core";
import type { NexusMailboxConfig } from "./types.js";
import { createNexusMailboxClient } from "./client.js";
import { mapNexusEnvelopeToAgentMessage } from "./map-message.js";
import { createSeenSet } from "./seen-set.js";

const DEFAULT_PREFIX = "ipc";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function createNexusMailbox(config: NexusMailboxConfig): Promise<MailboxComponent> {
  const prefix = config.inboxMethodPrefix ?? DEFAULT_PREFIX;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) {
      return config.fallback;
    }
  }

  const client = createNexusMailboxClient(config.transport, prefix);
  const seen = createSeenSet();
  const handlers = new Set<(message: AgentMessage) => void | Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let degraded = false;

  async function pollOnce(): Promise<void> {
    if (degraded && config.fallback !== undefined) return;
    const listed = await client.list(config.agentId as string, pageSize);
    if (!listed.ok) {
      if (config.fallback !== undefined) degraded = true;
      return;
    }
    for (const envelope of listed.value) {
      if (seen.has(envelope.id)) continue;
      const message = mapNexusEnvelopeToAgentMessage(envelope);
      seen.add(message);
      for (const handler of handlers) {
        await handler(message);
      }
    }
  }

  function ensurePolling(): void {
    if (timer !== null || degraded || handlers.size === 0) return;
    timer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
  }

  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    send: async (message) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.send(message);
      }
      const result = await client.send(message);
      if (!result.ok) {
        if (config.fallback !== undefined) {
          degraded = true;
          return config.fallback.send(message);
        }
        return result;
      }
      return { ok: true, value: mapNexusEnvelopeToAgentMessage(result.value) };
    },
    onMessage: (handler) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.onMessage(handler);
      }
      handlers.add(handler);
      ensurePolling();
      void pollOnce();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) stopPolling();
      };
    },
    list: async (filter) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.list(filter);
      }
      const listed = await client.list(config.agentId as string, filter?.limit ?? pageSize);
      if (!listed.ok) {
        if (config.fallback !== undefined) {
          degraded = true;
          return config.fallback.list(filter);
        }
        return [];
      }
      return listed.value.map(mapNexusEnvelopeToAgentMessage);
    },
    drain: () => seen.drain(),
  };
}
```

- [ ] **Step 2: Update `index.ts` exports**

Replace `packages/lib/ipc-nexus/src/index.ts` with:

```typescript
export type { NexusMailboxClient } from "./client.js";
export type { NexusMailboxConfig, NexusEnvelope, NexusInboxResponse } from "./types.js";
export { createNexusMailbox } from "./mailbox.js";
```

- [ ] **Step 3: Run the mailbox tests**

Run:

```bash
bun test packages/lib/ipc-nexus/src/mailbox.test.ts packages/lib/ipc-nexus/src/__tests__/api-surface.test.ts
```

Expected: basic send test passes; additional behavior tests are still missing.

---

### Task 5: Add fallback, polling, and drain behavior tests

**Files:**
- Modify: `packages/lib/ipc-nexus/src/mailbox.test.ts`

- [ ] **Step 1: Extend the mailbox test file**

Add these tests to `packages/lib/ipc-nexus/src/mailbox.test.ts`:

```typescript
test("uses fallback mailbox when health check fails", async () => {
  const { createLocalMailbox } = await import("@koi/ipc-local");
  const { createNexusMailbox } = await import("./index.js");

  const fallback = createLocalMailbox({ agentId: agentId("agent-a") });
  const mailbox = await createNexusMailbox({
    agentId: agentId("agent-a"),
    transport: {
      kind: "http",
      call: async () => ({
        ok: false as const,
        error: { code: "EXTERNAL", message: "down", retryable: false },
      }),
      health: async () => ({
        ok: false as const,
        error: { code: "EXTERNAL", message: "down", retryable: false },
      }),
      close: () => {},
    },
    fallback,
  });

  const result = await mailbox.send({
    from: agentId("agent-a"),
    to: agentId("agent-a"),
    kind: "event",
    type: "noop",
    payload: {},
  });

  expect(result.ok).toBe(true);
});

test("drain returns seen messages once", async () => {
  const { createNexusMailbox } = await import("./index.js");

  const transport = {
    kind: "http" as const,
    call: async (method: string) => {
      if (method === "ipc.list") {
        return {
          ok: true as const,
          value: {
            messages: [
              {
                id: "msg-2",
                from: "agent-b",
                to: "agent-a",
                kind: "event",
                type: "status",
                payload: { ok: true },
                createdAt: "2026-05-06T00:00:00.000Z",
              },
            ],
          },
        };
      }
      return {
        ok: false as const,
        error: { code: "EXTERNAL", message: "unexpected", retryable: false },
      };
    },
    health: async () => ({
      ok: true as const,
      value: { status: "ok" as const, version: "1", latencyMs: 1, probed: ["version"] },
    }),
    close: () => {},
  };

  const mailbox = await createNexusMailbox({ agentId: agentId("agent-a"), transport });
  const unsubscribe = mailbox.onMessage(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  unsubscribe();

  expect(mailbox.drain()).toHaveLength(1);
  expect(mailbox.drain()).toHaveLength(0);
});
```

- [ ] **Step 2: Run the package tests**

Run:

```bash
bun test packages/lib/ipc-nexus/src
```

Expected: all `ipc-nexus` tests pass.

---

### Task 6: Wire docs and workspace metadata

**Files:**
- Create: `docs/L2/ipc-nexus.md`
- Modify: `docs/package-coverage-map.md`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write the package doc**

Create `docs/L2/ipc-nexus.md` describing:

- the contract implemented
- the config shape
- polling-first design
- explicit fallback behavior
- examples using an injected `NexusTransport`

- [ ] **Step 2: Register workspace metadata**

Update the root `package.json` and `tsconfig.json` so the new package participates in the workspace and project references the same way `packages/lib/ipc-local` does.

- [ ] **Step 3: Update package coverage map**

Edit `docs/package-coverage-map.md` so `@koi/ipc-nexus` points at `packages/lib/ipc-nexus` and describes the implemented polling-based scope rather than the broader archive-era package.

- [ ] **Step 4: Run lint, typecheck, and tests**

Run:

```bash
bun test packages/lib/ipc-nexus/src
bun run typecheck
bun run build
```

Expected:

- `ipc-nexus` tests pass
- repository typecheck passes
- build completes with the new package included

---

## Self-Review Notes

- This plan intentionally limits Phase 1 to polling-only IPC.
- The fallback design is explicit and injected; no hidden local mailbox creation.
- `scratchpad-nexus` and `workspace-nexus` are deliberately left for follow-up plans after this slice lands.
