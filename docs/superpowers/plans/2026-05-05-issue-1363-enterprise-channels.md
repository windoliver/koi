# Enterprise Channels (Email, Teams, WhatsApp) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new L2 packages (`@koi/channel-email`, `@koi/channel-teams`, `@koi/channel-whatsapp`) implementing the `ChannelAdapter` contract, satisfying the design at `docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md`.

**Architecture:** Each package follows the `@koi/channel-slack` pattern (factory + descriptor + DI'd transports). Shared store interfaces (IdempotencyStore, IngressQueue, ThreadStore, OutboxStore, ConversationAddressStore) live in `@koi/channel-base`. Webhook channels (Teams, WhatsApp) expose `handleHttpRequest`. All three use durable two-phase lease/commit idempotency with channel-managed automatic lease renewal and a separate handler-worker that decouples provider acks from user side effects.

**Tech Stack:** Bun 1.3.x, TypeScript 6 (strict, ESM-only), bun:test, tsup, Biome, Zod (config validation), `imapflow` + `nodemailer` + `mailparser` (email), `jose` (Teams JWT), `fetch` + `Bun.CryptoHasher` (WhatsApp).

---

## Conventions used in this plan

- Each new file is created with a header comment matching `@koi/channel-slack` style.
- Every source file has a colocated `*.test.ts`. Integration tests live in `__tests__/`.
- After each green test step, run Biome (`bun run lint`) and typecheck (`bun run typecheck`) before committing.
- Commits use conventional-commit format (`feat(channel-email):`, `test(channel-teams):`, `docs(channel-whatsapp):`).
- All file paths are relative to repo root unless prefixed with `~/`.
- "Run X and confirm PASS" means: command exits 0; copy any failure output back into the conversation if not.

---

## Phase 0 — Shared store interfaces in `@koi/channel-base`

All three channel packages need the same store interfaces. Per the design's "Two-phase reservation" section, the data shapes are identical — only the keys differ. Place the interfaces and the in-memory test implementations in `@koi/channel-base` so each channel imports rather than duplicates.

### Task 0.1: Create the IdempotencyStore interface and in-memory implementation

**Files:**
- Create: `packages/lib/channel-base/src/idempotency-store.ts`
- Create: `packages/lib/channel-base/src/idempotency-store.test.ts`
- Modify: `packages/lib/channel-base/src/index.ts` (add export)

- [ ] **Step 1: Write failing tests** (`idempotency-store.test.ts`)

```typescript
import { describe, expect, test } from "bun:test";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type Lease,
} from "./idempotency-store.js";

describe("InMemoryIdempotencyStore", () => {
  const ttl = 1000;

  test("tryBegin returns ok for unseen key", async () => {
    const s: IdempotencyStore = new InMemoryIdempotencyStore();
    const r = await s.tryBegin("k1", 100);
    expect(r.ok).toBe(true);
  });

  test("concurrent tryBegin: exactly one ok", async () => {
    const s = new InMemoryIdempotencyStore();
    const [a, b] = await Promise.all([s.tryBegin("k1", 100), s.tryBegin("k1", 100)]);
    const oks = [a, b].filter((r) => r.ok).length;
    expect(oks).toBe(1);
  });

  test("commit then tryBegin returns committed", async () => {
    const s = new InMemoryIdempotencyStore();
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error("first should win");
    await s.commit(r.lease, ttl);
    const r2 = await s.tryBegin("k1", 100);
    expect(r2).toEqual({ ok: false, reason: "committed" });
  });

  test("abort releases lease for re-claim", async () => {
    const s = new InMemoryIdempotencyStore();
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await s.abort(r.lease);
    const r2 = await s.tryBegin("k1", 100);
    expect(r2.ok).toBe(true);
  });

  test("renew extends lease", async () => {
    const s = new InMemoryIdempotencyStore({ now: () => 0 });
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await s.renew(r.lease, 200);
    const r2 = await s.tryBegin("k1", 100);
    expect(r2).toEqual({ ok: false, reason: "in-flight" });
  });

  test("capacity exhausted returns reason", async () => {
    const s = new InMemoryIdempotencyStore({ maxCommittedRecords: 1 });
    const r1 = await s.tryBegin("k1", 100);
    if (!r1.ok) throw new Error();
    await s.commit(r1.lease, 1000);
    const r2 = await s.tryBegin("k2", 100);
    expect(r2).toEqual({ ok: false, reason: "capacity-exhausted" });
  });

  test("commit ttl expiry releases for re-delivery", async () => {
    let now = 0;
    const s = new InMemoryIdempotencyStore({ now: () => now });
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await s.commit(r.lease, 50);
    now = 51;
    const r2 = await s.tryBegin("k1", 100);
    expect(r2.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/lib/channel-base/src/idempotency-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`idempotency-store.ts`)

```typescript
/**
 * @koi/channel-base — IdempotencyStore: two-phase reservation + commit.
 *
 * See docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md.
 */

export type Lease = {
  readonly key: string;
  readonly token: string;
  readonly expiresAt: number;
};

export type TryBeginResult =
  | { readonly ok: true; readonly lease: Lease }
  | {
      readonly ok: false;
      readonly reason: "in-flight" | "committed" | "capacity-exhausted";
    };

export interface IdempotencyStore {
  tryBegin(key: string, leaseMs: number): Promise<TryBeginResult>;
  commit(lease: Lease, commitTtlMs: number): Promise<void>;
  abort(lease: Lease): Promise<void>;
  renew(lease: Lease, leaseMs: number): Promise<void>;
}

export type InMemoryIdempotencyStoreOptions = {
  readonly maxCommittedRecords?: number;
  readonly now?: () => number;
};

type LeaseRecord = { token: string; expiresAt: number };
type CommittedRecord = { expiresAt: number };

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #committed = new Map<string, CommittedRecord>();
  readonly #maxCommitted: number;
  readonly #now: () => number;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.#maxCommitted = options.maxCommittedRecords ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  async tryBegin(key: string, leaseMs: number): Promise<TryBeginResult> {
    const now = this.#now();
    const committed = this.#committed.get(key);
    if (committed && committed.expiresAt > now) {
      return { ok: false, reason: "committed" };
    }
    if (committed) this.#committed.delete(key);
    const live = this.#leases.get(key);
    if (live && live.expiresAt > now) {
      return { ok: false, reason: "in-flight" };
    }
    if (this.#committed.size >= this.#maxCommitted) {
      return { ok: false, reason: "capacity-exhausted" };
    }
    const token = crypto.randomUUID();
    const expiresAt = now + leaseMs;
    this.#leases.set(key, { token, expiresAt });
    return { ok: true, lease: { key, token, expiresAt } };
  }

  async commit(lease: Lease, commitTtlMs: number): Promise<void> {
    const live = this.#leases.get(lease.key);
    if (!live || live.token !== lease.token) {
      throw new Error(`commit: lease ${lease.key} not held`);
    }
    this.#leases.delete(lease.key);
    this.#committed.set(lease.key, { expiresAt: this.#now() + commitTtlMs });
  }

  async abort(lease: Lease): Promise<void> {
    const live = this.#leases.get(lease.key);
    if (live && live.token === lease.token) this.#leases.delete(lease.key);
  }

  async renew(lease: Lease, leaseMs: number): Promise<void> {
    const live = this.#leases.get(lease.key);
    if (!live || live.token !== lease.token) {
      throw new Error(`renew: lease ${lease.key} not held`);
    }
    live.expiresAt = this.#now() + leaseMs;
  }
}
```

- [ ] **Step 4: Run tests and confirm PASS**

Run: `bun test packages/lib/channel-base/src/idempotency-store.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Add export**

Append to `packages/lib/channel-base/src/index.ts`:

```typescript
export type {
  IdempotencyStore,
  Lease,
  TryBeginResult,
  InMemoryIdempotencyStoreOptions,
} from "./idempotency-store.js";
export { InMemoryIdempotencyStore } from "./idempotency-store.js";
```

- [ ] **Step 6: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck && \
git add packages/lib/channel-base/src/idempotency-store.ts \
        packages/lib/channel-base/src/idempotency-store.test.ts \
        packages/lib/channel-base/src/index.ts && \
git commit -m "feat(channel-base): add IdempotencyStore + InMemoryIdempotencyStore"
```

### Task 0.2: IngressQueue interface + InMemoryIngressQueue

**Files:**
- Create: `packages/lib/channel-base/src/ingress-queue.ts`
- Create: `packages/lib/channel-base/src/ingress-queue.test.ts`
- Modify: `packages/lib/channel-base/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { InMemoryIngressQueue, type QueueItem } from "./ingress-queue.js";

const item = (key: string): QueueItem => ({ key, payload: { hello: key }, normalized: null });

describe("InMemoryIngressQueue", () => {
  test("enqueue returns ok for new key", async () => {
    const q = new InMemoryIngressQueue();
    const r = await q.enqueue("k1", item("k1"));
    expect(r).toEqual({ ok: true });
  });

  test("enqueue rejects duplicate", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const r = await q.enqueue("k1", item("k1"));
    expect(r).toEqual({ ok: false, reason: "duplicate" });
  });

  test("claim returns enqueued item", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c = await q.claim("w1", 1000);
    expect(c?.key).toBe("k1");
  });

  test("claim returns null when empty", async () => {
    const q = new InMemoryIngressQueue();
    expect(await q.claim("w1", 1000)).toBeNull();
  });

  test("ack removes item", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c = await q.claim("w1", 1000);
    if (!c) throw new Error();
    await q.ack("w1", "k1");
    expect(await q.claim("w1", 1000)).toBeNull();
  });

  test("nack increments attempts and re-claimable", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c1 = await q.claim("w1", 1);
    if (!c1) throw new Error();
    await q.nack("w1", "k1");
    const c2 = await q.claim("w1", 1000);
    expect(c2?.attempts).toBe(1);
  });

  test("deadLetter moves out of main queue", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c = await q.claim("w1", 1000);
    if (!c) throw new Error();
    await q.deadLetter("w1", "k1", "max-retries");
    expect(await q.claim("w1", 1000)).toBeNull();
    const dl = await q.getDeadLetters();
    expect(dl).toHaveLength(1);
    expect(dl[0]?.reason).toBe("max-retries");
  });
});
```

- [ ] **Step 2: Confirm fail**

Run: `bun test packages/lib/channel-base/src/ingress-queue.test.ts`

- [ ] **Step 3: Implement** (`ingress-queue.ts`)

```typescript
export type QueueItem<P = unknown, N = unknown> = {
  readonly key: string;
  readonly payload: P;
  readonly normalized: N;
};

export type ClaimedItem<P = unknown, N = unknown> = QueueItem<P, N> & {
  readonly attempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
};

export type DeadLetterItem<P = unknown, N = unknown> = QueueItem<P, N> & {
  readonly attempts: number;
  readonly reason: string;
};

export type EnqueueResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "duplicate" };

export interface IngressQueue<P = unknown, N = unknown> {
  enqueue(key: string, item: QueueItem<P, N>): Promise<EnqueueResult>;
  claim(workerId: string, leaseMs: number): Promise<ClaimedItem<P, N> | null>;
  ack(workerId: string, key: string): Promise<void>;
  nack(workerId: string, key: string): Promise<void>;
  deadLetter(workerId: string, key: string, reason: string): Promise<void>;
  getDeadLetters(): Promise<readonly DeadLetterItem<P, N>[]>;
}

type InternalRecord<P, N> = {
  item: QueueItem<P, N>;
  attempts: number;
  claim: { workerId: string; token: string; expiresAt: number } | null;
};

export type InMemoryIngressQueueOptions = { readonly now?: () => number };

export class InMemoryIngressQueue<P = unknown, N = unknown> implements IngressQueue<P, N> {
  readonly #records = new Map<string, InternalRecord<P, N>>();
  readonly #dead: DeadLetterItem<P, N>[] = [];
  readonly #now: () => number;

  constructor(options: InMemoryIngressQueueOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async enqueue(key: string, item: QueueItem<P, N>): Promise<EnqueueResult> {
    if (this.#records.has(key)) return { ok: false, reason: "duplicate" };
    this.#records.set(key, { item, attempts: 0, claim: null });
    return { ok: true };
  }

  async claim(workerId: string, leaseMs: number): Promise<ClaimedItem<P, N> | null> {
    const now = this.#now();
    for (const [, rec] of this.#records) {
      if (rec.claim && rec.claim.expiresAt > now) continue;
      const token = crypto.randomUUID();
      rec.claim = { workerId, token, expiresAt: now + leaseMs };
      return {
        ...rec.item,
        attempts: rec.attempts,
        leaseToken: token,
        leaseExpiresAt: rec.claim.expiresAt,
      };
    }
    return null;
  }

  async ack(workerId: string, key: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId === workerId) this.#records.delete(key);
  }

  async nack(workerId: string, key: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId === workerId) {
      rec.attempts += 1;
      rec.claim = null;
    }
  }

  async deadLetter(workerId: string, key: string, reason: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId !== workerId) return;
    this.#dead.push({ ...rec.item, attempts: rec.attempts, reason });
    this.#records.delete(key);
  }

  async getDeadLetters(): Promise<readonly DeadLetterItem<P, N>[]> {
    return this.#dead.slice();
  }
}
```

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Append exports** to `packages/lib/channel-base/src/index.ts`:

```typescript
export type {
  IngressQueue,
  QueueItem,
  ClaimedItem,
  DeadLetterItem,
  EnqueueResult,
  InMemoryIngressQueueOptions,
} from "./ingress-queue.js";
export { InMemoryIngressQueue } from "./ingress-queue.js";
```

- [ ] **Step 6: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck && \
git add packages/lib/channel-base/src/ingress-queue.ts \
        packages/lib/channel-base/src/ingress-queue.test.ts \
        packages/lib/channel-base/src/index.ts && \
git commit -m "feat(channel-base): add IngressQueue + InMemoryIngressQueue"
```

### Task 0.3: HandlerWorker (drives the queue → handler dispatch loop)

**Files:**
- Create: `packages/lib/channel-base/src/handler-worker.ts`
- Create: `packages/lib/channel-base/src/handler-worker.test.ts`
- Modify: `packages/lib/channel-base/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";
import { startHandlerWorker } from "./handler-worker.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("HandlerWorker", () => {
  test("invokes handler exactly once on success", async () => {
    const queue = new InMemoryIngressQueue<{ v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    const calls: number[] = [];
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: idem,
      handler: async (item) => {
        calls.push(item.payload.v);
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 42 }, normalized: null });
    await tick();
    await stop();
    expect(calls).toEqual([42]);
  });

  test("retries on handler throw up to maxRetries then dead-letters", async () => {
    const queue = new InMemoryIngressQueue<{ v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let attempts = 0;
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: idem,
      handler: async () => {
        attempts++;
        throw new Error("boom");
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      maxHandlerRetries: 2,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick();
    await tick();
    await stop();
    expect(attempts).toBeGreaterThanOrEqual(2);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(1);
  });

  test("auto-renews lease while handler runs", async () => {
    const queue = new InMemoryIngressQueue<{ v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let renewals = 0;
    const renewSpy: typeof idem.renew = async (lease, ms) => {
      renewals++;
      return idem.renew(lease, ms);
    };
    const wrapped = Object.assign({}, idem, { renew: renewSpy });
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: wrapped,
      handler: async () => new Promise((r) => setTimeout(r, 60)),
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      leaseMs: 30,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await new Promise((r) => setTimeout(r, 80));
    await stop();
    expect(renewals).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Confirm fail**

- [ ] **Step 3: Implement** (`handler-worker.ts`)

```typescript
import type { IdempotencyStore } from "./idempotency-store.js";
import type { IngressQueue } from "./ingress-queue.js";

export type HandlerWorkerOptions<P, N> = {
  readonly queue: IngressQueue<P, N>;
  readonly idempotencyStore: IdempotencyStore;
  readonly handler: (item: { readonly key: string; readonly payload: P; readonly normalized: N }) => Promise<void>;
  readonly commitTtlMs: number;
  readonly handlerTimeoutMs: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxHandlerRetries?: number;
  readonly workerId: string;
};

export function startHandlerWorker<P, N>(opts: HandlerWorkerOptions<P, N>): () => Promise<void> {
  const leaseMs = opts.leaseMs ?? 30_000;
  const pollMs = opts.pollIntervalMs ?? 250;
  const maxRetries = opts.maxHandlerRetries ?? 3;
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      const claimed = await opts.queue.claim(opts.workerId, leaseMs);
      if (!claimed) {
        await sleep(pollMs);
        continue;
      }
      const begin = await opts.idempotencyStore.tryBegin(claimed.key, leaseMs);
      if (!begin.ok) {
        // Already committed or in-flight elsewhere — drop from queue.
        await opts.queue.ack(opts.workerId, claimed.key);
        continue;
      }
      const renewer = setInterval(() => {
        opts.idempotencyStore.renew(begin.lease, leaseMs).catch(() => {});
      }, Math.max(1, Math.floor(leaseMs / 3)));
      try {
        await runWithTimeout(
          opts.handler({ key: claimed.key, payload: claimed.payload, normalized: claimed.normalized }),
          opts.handlerTimeoutMs,
        );
        await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs);
        await opts.queue.ack(opts.workerId, claimed.key);
      } catch (e) {
        await opts.idempotencyStore.abort(begin.lease).catch(() => {});
        if (claimed.attempts + 1 >= maxRetries) {
          await opts.queue.deadLetter(opts.workerId, claimed.key, errorMessage(e));
        } else {
          await opts.queue.nack(opts.workerId, claimed.key);
        }
      } finally {
        clearInterval(renewer);
      }
    }
  };

  const running = loop();
  return async () => {
    stopped = true;
    await running.catch(() => {});
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`handler timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Export from index**

Add: `export { startHandlerWorker, type HandlerWorkerOptions } from "./handler-worker.js";`

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck && \
git add packages/lib/channel-base/src/handler-worker.ts \
        packages/lib/channel-base/src/handler-worker.test.ts \
        packages/lib/channel-base/src/index.ts && \
git commit -m "feat(channel-base): add startHandlerWorker for queue-driven handler dispatch"
```

### Task 0.4: ThreadStore + OutboxStore + ConversationAddressStore interfaces

**Files:**
- Create: `packages/lib/channel-base/src/thread-store.ts` + test
- Create: `packages/lib/channel-base/src/outbox-store.ts` + test
- Create: `packages/lib/channel-base/src/conversation-address-store.ts` + test
- Modify: `packages/lib/channel-base/src/index.ts`

These three are simpler — interface + in-memory CAS impl. Same pattern as 0.1.

- [ ] **Step 1: Write `thread-store.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { InMemoryThreadStore, type ThreadState } from "./thread-store.js";

const state = (chain: readonly string[]): ThreadState => ({ chain });

describe("InMemoryThreadStore", () => {
  test("get returns null for unknown thread", async () => {
    const s = new InMemoryThreadStore();
    expect(await s.get("t1")).toBeNull();
  });

  test("first cas with version 0 succeeds", async () => {
    const s = new InMemoryThreadStore();
    expect(await s.cas("t1", 0, state(["m1"]))).toBe(true);
    const r = await s.get("t1");
    expect(r?.version).toBe(1);
    expect(r?.state.chain).toEqual(["m1"]);
  });

  test("cas with stale version fails", async () => {
    const s = new InMemoryThreadStore();
    await s.cas("t1", 0, state(["m1"]));
    expect(await s.cas("t1", 0, state(["m2"]))).toBe(false);
  });

  test("read-modify-write loop wins after retry", async () => {
    const s = new InMemoryThreadStore();
    await s.cas("t1", 0, state(["m1"]));
    const cur = await s.get("t1");
    if (!cur) throw new Error();
    expect(await s.cas("t1", cur.version, state([...cur.state.chain, "m2"]))).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm fail; implement `thread-store.ts`**

```typescript
export type ThreadState = { readonly chain: readonly string[] };

export interface ThreadStore {
  get(threadKey: string): Promise<{ readonly state: ThreadState; readonly version: number } | null>;
  cas(threadKey: string, expectedVersion: number, next: ThreadState): Promise<boolean>;
}

type Record = { state: ThreadState; version: number };

export class InMemoryThreadStore implements ThreadStore {
  readonly #map = new Map<string, Record>();
  async get(k: string): Promise<{ state: ThreadState; version: number } | null> {
    const r = this.#map.get(k);
    return r ? { state: r.state, version: r.version } : null;
  }
  async cas(k: string, expected: number, next: ThreadState): Promise<boolean> {
    const cur = this.#map.get(k);
    const v = cur?.version ?? 0;
    if (v !== expected) return false;
    this.#map.set(k, { state: next, version: v + 1 });
    return true;
  }
}
```

- [ ] **Step 3: Tests pass; commit `thread-store`**

- [ ] **Step 4: Repeat pattern for `outbox-store.ts`** — interface:

```typescript
export type OutboxStatus = "reserved" | "sending" | "sent" | "aborted" | "awaiting-recovery";

export type OutboxRecord = {
  readonly messageId: string;
  readonly threadKey: string;
  readonly threadVersion: number;
  readonly payloadHash: string;
  readonly status: OutboxStatus;
  readonly createdAt: number;
};

export interface OutboxStore {
  put(record: OutboxRecord): Promise<void>;
  cas(messageId: string, expectedStatus: OutboxStatus, nextStatus: OutboxStatus): Promise<boolean>;
  get(messageId: string): Promise<OutboxRecord | null>;
  list(filter: { readonly status: OutboxStatus }): Promise<readonly OutboxRecord[]>;
}

export class InMemoryOutboxStore implements OutboxStore {
  readonly #map = new Map<string, OutboxRecord>();
  async put(r: OutboxRecord): Promise<void> { this.#map.set(r.messageId, r); }
  async cas(id: string, expected: OutboxStatus, next: OutboxStatus): Promise<boolean> {
    const cur = this.#map.get(id);
    if (!cur || cur.status !== expected) return false;
    this.#map.set(id, { ...cur, status: next });
    return true;
  }
  async get(id: string): Promise<OutboxRecord | null> { return this.#map.get(id) ?? null; }
  async list(filter: { status: OutboxStatus }): Promise<readonly OutboxRecord[]> {
    return [...this.#map.values()].filter((r) => r.status === filter.status);
  }
}
```

  Test: `put` then `get` round-trips; `cas` succeeds on matching status, fails on mismatch; `list` filters by status. Same skeleton as `thread-store.test.ts`.

- [ ] **Step 5: Repeat pattern for `conversation-address-store.ts`** — interface:

```typescript
export type ConversationAddress = {
  readonly serviceUrl: string;
  readonly tenantId: string;
  readonly channelId: string;
  readonly recipient: { readonly id: string; readonly name?: string };
  readonly lastSeenAt: number;
};

export interface ConversationAddressStore {
  put(conversationId: string, address: ConversationAddress): Promise<void>;
  get(conversationId: string): Promise<ConversationAddress | null>;
}

export class InMemoryConversationAddressStore implements ConversationAddressStore {
  readonly #map = new Map<string, ConversationAddress>();
  async put(id: string, addr: ConversationAddress): Promise<void> { this.#map.set(id, addr); }
  async get(id: string): Promise<ConversationAddress | null> { return this.#map.get(id) ?? null; }
}
```

  Test: `put` then `get` returns the same address; `get` returns null for unknown id; subsequent `put` overwrites.

- [ ] **Step 6: Add all exports to `index.ts` and commit one consolidated change**

```bash
bun run lint && bun run typecheck && bun test packages/lib/channel-base && \
git add packages/lib/channel-base/src/{thread,outbox,conversation-address}-store{,.test}.ts \
        packages/lib/channel-base/src/index.ts && \
git commit -m "feat(channel-base): add ThreadStore, OutboxStore, ConversationAddressStore"
```

### Task 0.5: Webhook handler helper (auth → enqueue → response)

**Files:**
- Create: `packages/lib/channel-base/src/webhook-handler.ts` + test
- Modify: `packages/lib/channel-base/src/index.ts`

A small helper used by Teams + WhatsApp `handleHttpRequest` to do the common: `verify → key → tryBegin → enqueue → 200/4xx/5xx`.

- [ ] **Step 1: Write `webhook-handler.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { handleWebhookIngress } from "./webhook-handler.js";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";

const setup = () => ({
  idem: new InMemoryIdempotencyStore(),
  queue: new InMemoryIngressQueue(),
});

describe("handleWebhookIngress", () => {
  test("auth fail returns 401", async () => {
    const { idem, queue } = setup();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: false, status: 401, message: "bad sig" }),
      extractKey: () => "k",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(401);
  });

  test("happy path: enqueue + 200", async () => {
    const { idem, queue } = setup();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: { x: 1 }, normalized: { y: 2 } }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(200);
    const c = await queue.claim("w1", 100);
    expect(c?.key).toBe("k1");
  });

  test("committed key returns 200 silently", async () => {
    const { idem, queue } = setup();
    const r = await idem.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await idem.commit(r.lease, 1000);
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 1000,
      inFlightWaitMs: 1,
    });
    expect(res.status).toBe(200);
  });

  test("in-flight returns 503 after wait", async () => {
    const { idem, queue } = setup();
    const r = await idem.tryBegin("k1", 1000);
    if (!r.ok) throw new Error();
    const res = await handleWebhookIngress({
      request: new Request("http://x/x", { method: "POST" }),
      verify: async () => ({ ok: true }),
      extractKey: () => "k1",
      parsePayload: async () => ({ payload: {}, normalized: null }),
      idempotencyStore: idem,
      ingressQueue: queue,
      leaseMs: 100,
      inFlightWaitMs: 5,
    });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Confirm fail; implement**

```typescript
import type { IdempotencyStore } from "./idempotency-store.js";
import type { IngressQueue, QueueItem } from "./ingress-queue.js";

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

export type WebhookIngressOptions<P, N> = {
  readonly request: Request;
  readonly verify: (request: Request) => Promise<VerifyResult>;
  readonly extractKey: (parsed: P) => string;
  readonly parsePayload: (request: Request) => Promise<{ payload: P; normalized: N }>;
  readonly idempotencyStore: IdempotencyStore;
  readonly ingressQueue: IngressQueue<P, N>;
  readonly leaseMs: number;
  readonly inFlightWaitMs: number;
  readonly handshakeResponse?: () => Promise<Response | null>;
};

export async function handleWebhookIngress<P, N>(o: WebhookIngressOptions<P, N>): Promise<Response> {
  if (o.handshakeResponse) {
    const handshake = await o.handshakeResponse();
    if (handshake) return handshake;
  }
  const v = await o.verify(o.request);
  if (!v.ok) return new Response(v.message, { status: v.status });

  let parsed: { payload: P; normalized: N };
  try {
    parsed = await o.parsePayload(o.request);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "bad payload", { status: 400 });
  }
  const key = o.extractKey(parsed.payload);

  const begin = await o.idempotencyStore.tryBegin(key, o.leaseMs);
  if (!begin.ok && begin.reason === "committed") return new Response(null, { status: 200 });
  if (!begin.ok && begin.reason === "in-flight") {
    const t0 = Date.now();
    while (Date.now() - t0 < o.inFlightWaitMs) {
      await new Promise((r) => setTimeout(r, 5));
      const r2 = await o.idempotencyStore.tryBegin(key, o.leaseMs);
      if (!r2.ok && r2.reason === "committed") return new Response(null, { status: 200 });
      if (r2.ok) {
        await o.idempotencyStore.abort(r2.lease);
        break;
      }
    }
    return new Response("in-flight", { status: 503 });
  }
  if (!begin.ok && begin.reason === "capacity-exhausted") {
    return new Response("capacity", { status: 503 });
  }
  if (!begin.ok) return new Response("unknown", { status: 500 });

  // ok: enqueue then release lease (the worker will re-claim).
  const item: QueueItem<P, N> = { key, payload: parsed.payload, normalized: parsed.normalized };
  const enq = await o.ingressQueue.enqueue(key, item);
  await o.idempotencyStore.abort(begin.lease);
  if (!enq.ok && enq.reason === "duplicate") return new Response(null, { status: 200 });
  return new Response(null, { status: 200 });
}
```

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Export + commit**

```bash
bun run lint && bun run typecheck && \
git add packages/lib/channel-base/src/webhook-handler{,.test}.ts \
        packages/lib/channel-base/src/index.ts && \
git commit -m "feat(channel-base): add handleWebhookIngress helper"
```

---

## Phase 1 — `@koi/channel-email` package

### Task 1.0: Package scaffolding + L2 doc

**Files:**
- Create: `packages/lib/channel-email/package.json`
- Create: `packages/lib/channel-email/tsconfig.json`
- Create: `packages/lib/channel-email/tsup.config.ts`
- Create: `docs/L2/channel-email.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@koi/channel-email",
  "description": "Email channel: IMAP IDLE inbound + SMTP outbound with durable threading",
  "version": "0.0.0",
  "private": true,
  "koi": { "optional": true },
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "dependencies": {
    "@koi/channel-base": "workspace:*",
    "@koi/core": "workspace:*",
    "imapflow": "1.0.171",
    "mailparser": "3.7.2",
    "nodemailer": "6.10.1"
  },
  "devDependencies": {
    "@types/nodemailer": "6.4.17"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../channel-base" }
  ]
}
```

- [ ] **Step 3: Write `tsup.config.ts`**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  treeshake: true,
  target: "node22",
  external: ["imapflow", "nodemailer", "mailparser"],
});
```

- [ ] **Step 4: Write `docs/L2/channel-email.md`** — short doc summarizing: purpose, public API (`createEmailChannel`, `EmailDescriptor`), DI surface, store requirements, error codes. Reference the spec for full detail.

```markdown
# @koi/channel-email

L2 channel adapter for email (IMAP IDLE inbound, SMTP outbound).

## Purpose

Bidirectional email integration with RFC 5322 thread tracking. Designed for
agent deployments that need durable, crash-safe email conversations.

## Public API

- `createEmailChannel(config, deps): EmailChannelAdapter` — factory.
- `EmailDescriptor` — manifest binding.
- `EmailConfig`, `EmailChannelAdapter`, `EmailDependencies`.

See `src/index.ts` for the full export list.

## Required dependencies (DI)

- `imap`, `smtp`, `parser` — transport adapters wrapping `imapflow`,
  `nodemailer`, `mailparser` respectively.
- `threadStore`, `outboxStore` — CAS-backed; mandatory for production.
- `idempotencyStore`, `ingressQueue` — durable required; in-memory rejected
  by config validation when `production: true`.
- `idGenerator` — outbound `Message-ID` generator (default UUID).
- `clock` — injected `() => number`; defaults to `Date.now`.

## Error codes

`INVALID_CONFIG`, `AUTH_FAILED`, `CONNECTION_LOST`, `PARSE_FAILED`,
`SEND_FAILED`, `UNSUPPORTED_TRANSPORT`, `THREAD_BLOCKED_PENDING_RECOVERY`,
`RECOVERY_CONFLICT`, `ALREADY_RESOLVED`.

## Outbound state machine

`reserved → sending → sent | aborted | awaiting-recovery`.
See `docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md`
for full transition rules and recovery semantics (`resolvePending`).

## Operational notes

- IMAP transport must support UIDVALIDITY+UID dedupe; POP3 is rejected at
  config time with `UNSUPPORTED_TRANSPORT`.
- `getPendingSends()` and `resolvePending(messageId, outcome)` are operator
  APIs; do not call from agent handlers.
- `autoRetryAfterDataAck` is `false` by default; enabling it accepts duplicate
  user-visible mail risk.
```

- [ ] **Step 5: Run install + commit**

```bash
bun install --frozen-lockfile 2>&1 | tail -3 && \
bun run typecheck && \
git add packages/lib/channel-email/{package.json,tsconfig.json,tsup.config.ts} \
        docs/L2/channel-email.md && \
git commit -m "feat(channel-email): scaffold package + L2 doc"
```

### Task 1.1: `config.ts` (Zod schema + validation)

**Files:**
- Create: `packages/lib/channel-email/src/config.ts`
- Create: `packages/lib/channel-email/src/config.test.ts`

- [ ] **Step 1: Write tests**

Tests must cover: required fields, port ranges, `pollInterval` default, `autoRetryAfterDataAck` default `false`, factory rejects non-IMAP transport. Pattern follows `channel-slack/src/slack-channel.ts` config sub-section.

```typescript
import { describe, expect, test } from "bun:test";
import { validateEmailConfig } from "./config.js";

const valid = {
  imap: { host: "imap.example.com", port: 993, user: "u", pass: "p", mailbox: "INBOX" },
  smtp: { host: "smtp.example.com", port: 587, user: "u", pass: "p", from: "bot@example.com" },
};

describe("validateEmailConfig", () => {
  test("accepts minimal valid config", () => {
    const r = validateEmailConfig(valid);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.imap.host).toBe("imap.example.com");
    expect(r.value.autoRetryAfterDataAck).toBe(false);
  });

  test("rejects missing imap host", () => {
    const r = validateEmailConfig({ ...valid, imap: { ...valid.imap, host: "" } });
    expect(r.ok).toBe(false);
  });

  test("rejects port out of range", () => {
    const r = validateEmailConfig({ ...valid, imap: { ...valid.imap, port: 70000 } });
    expect(r.ok).toBe(false);
  });

  test("rejects malformed from address", () => {
    const r = validateEmailConfig({ ...valid, smtp: { ...valid.smtp, from: "not-an-email" } });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Confirm fail**

- [ ] **Step 3: Implement** using Zod (already a transitive dep via channel-base or sibling packages — check; if not, add to deps). Schema:

```typescript
import { z } from "zod";

const ImapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  pass: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
  tls: z.boolean().default(true),
});

const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  pass: z.string().min(1),
  from: z.string().email(),
  tls: z.boolean().default(true),
});

export const EmailConfigSchema = z.object({
  imap: ImapConfigSchema,
  smtp: SmtpConfigSchema,
  pollInterval: z.number().int().min(1).default(60_000),
  autoRetryAfterDataAck: z.boolean().default(false),
  production: z.boolean().default(false),
  handlerTimeoutMs: z.number().int().min(1).default(300_000),
  commitTtlMs: z.number().int().min(1).default(Number.MAX_SAFE_INTEGER),
});

export type EmailConfig = z.infer<typeof EmailConfigSchema>;

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: "INVALID_CONFIG"; readonly message: string } };

export function validateEmailConfig(input: unknown): Result<EmailConfig> {
  const r = EmailConfigSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: { code: "INVALID_CONFIG", message: r.error.message } };
}
```

  Verify Zod is reachable: `grep -l "\"zod\"" packages/lib/channel-base/package.json` — if not present in any L0u dep we transit, add `"zod": "3.24.1"` (match what's already in repo) to `packages/lib/channel-email/package.json` runtime deps and run `bun install`.

- [ ] **Step 4: Tests pass; lint; commit**

```bash
git add packages/lib/channel-email/src/config{,.test}.ts \
        packages/lib/channel-email/package.json && \
git commit -m "feat(channel-email): add validateEmailConfig"
```

### Task 1.2: `threading.ts` — pure thread-key + header derivation

**Files:**
- Create: `packages/lib/channel-email/src/threading.ts`
- Create: `packages/lib/channel-email/src/threading.test.ts`

These are pure functions: thread-key extraction from inbound `Message-ID`/`References`, and `In-Reply-To`/`References` header construction from a `ThreadState`.

- [ ] **Step 1: Tests**

```typescript
import { describe, expect, test } from "bun:test";
import { extractThreadKey, deriveReplyHeaders } from "./threading.js";

describe("extractThreadKey", () => {
  test("uses references root if present", () => {
    expect(
      extractThreadKey({
        messageId: "<m3@a>",
        inReplyTo: "<m2@a>",
        references: ["<m1@a>", "<m2@a>"],
      }),
    ).toBe("<m1@a>");
  });

  test("falls back to inReplyTo when references missing", () => {
    expect(extractThreadKey({ messageId: "<m2@a>", inReplyTo: "<m1@a>", references: [] })).toBe("<m1@a>");
  });

  test("falls back to messageId for new thread", () => {
    expect(extractThreadKey({ messageId: "<m1@a>", inReplyTo: undefined, references: [] })).toBe("<m1@a>");
  });
});

describe("deriveReplyHeaders", () => {
  test("empty chain produces no headers", () => {
    expect(deriveReplyHeaders({ chain: [] })).toEqual({});
  });
  test("single-element chain sets In-Reply-To and References", () => {
    expect(deriveReplyHeaders({ chain: ["<m1@a>"] })).toEqual({
      "In-Reply-To": "<m1@a>",
      References: "<m1@a>",
    });
  });
  test("multi-element chain references whole chain, In-Reply-To is last", () => {
    expect(deriveReplyHeaders({ chain: ["<m1@a>", "<m2@a>", "<m3@a>"] })).toEqual({
      "In-Reply-To": "<m3@a>",
      References: "<m1@a> <m2@a> <m3@a>",
    });
  });
});
```

- [ ] **Step 2: Implement; tests pass; commit**

```typescript
import type { ThreadState } from "@koi/channel-base";

export type IncomingHeaders = {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
};

export function extractThreadKey(h: IncomingHeaders): string {
  if (h.references.length > 0 && h.references[0]) return h.references[0];
  if (h.inReplyTo) return h.inReplyTo;
  return h.messageId;
}

export function deriveReplyHeaders(state: ThreadState): Record<string, string> {
  if (state.chain.length === 0) return {};
  const last = state.chain[state.chain.length - 1] ?? "";
  return {
    "In-Reply-To": last,
    References: state.chain.join(" "),
  };
}
```

```bash
bun test packages/lib/channel-email/src/threading.test.ts && \
git add packages/lib/channel-email/src/threading{,.test}.ts && \
git commit -m "feat(channel-email): add pure threading helpers"
```

### Task 1.3: `normalize.ts` — IMAP/MIME → InboundMessage

**Files:**
- Create: `packages/lib/channel-email/src/normalize.ts` + test

Take a `ParsedMail` (from mailparser) plus the IMAP UIDVALIDITY+UID and produce a `KoiMessage` (`InboundMessage` from `@koi/core`). Cover: text-only, HTML-only, multipart with attachments stripped to metadata, malformed `Date`, missing `From`, missing `Message-ID` (returns `Result.error UNSUPPORTED_TRANSPORT`).

- [ ] **Step 1: Tests** — copy structure from `archive/v1/packages/net/channel-email/src/normalize.test.ts`, adapt to v2 `InboundMessage` shape from `packages/kernel/core/src/message.ts`.

- [ ] **Step 2: Implement; tests pass**

- [ ] **Step 3: Commit**

```bash
git add packages/lib/channel-email/src/normalize{,.test}.ts && \
git commit -m "feat(channel-email): add IMAP/MIME → InboundMessage normalizer"
```

### Task 1.4: `format.ts` — OutboundMessage → SMTP envelope

**Files:**
- Create: `packages/lib/channel-email/src/format.ts` + test

Pure: `OutboundMessage` + `ThreadState` + outbound `Message-ID` → `{ from, to, subject, text, html?, headers }` for nodemailer.

- [ ] **Step 1: Tests** — text-only, with HTML, threaded reply (uses `deriveReplyHeaders`), no headers when chain empty.

- [ ] **Step 2: Implement; tests pass; commit**

```bash
git add packages/lib/channel-email/src/format{,.test}.ts && \
git commit -m "feat(channel-email): add OutboundMessage → SMTP envelope formatter"
```

### Task 1.5: `platform-send.ts` — SMTP transport adapter with phase classification

**Files:**
- Create: `packages/lib/channel-email/src/platform-send.ts` + test

Wraps a `SmtpTransport` interface (`sendMail`) and emits `{ phase: "pre-data" | "post-data", ok, error? }`. Pre-data classification rules: connection-refused, ECONNREFUSED, 4xx-5xx response codes pre-DATA, validation errors. Post-data: relay returned 250 OK, or socket dropped after we wrote the DATA terminator.

- [ ] **Step 1: Tests** — fake transport returns: success → post-data ok; pre-DATA throw → pre-data fail; post-DATA throw → post-data fail.

```typescript
import { describe, expect, test } from "bun:test";
import { sendViaSmtp, type SmtpTransport } from "./platform-send.js";

const fake = (impl: SmtpTransport["sendMail"]): SmtpTransport => ({ sendMail: impl });

describe("sendViaSmtp", () => {
  test("250 OK -> post-data ok", async () => {
    const r = await sendViaSmtp(
      fake(async () => ({ accepted: ["x"], rejected: [], response: "250 OK" })),
      { from: "a", to: ["b"], subject: "s", text: "t", headers: {} },
    );
    expect(r).toEqual({ phase: "post-data", ok: true });
  });

  test("ECONNREFUSED -> pre-data fail", async () => {
    const err = Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    const r = await sendViaSmtp(
      fake(async () => { throw err; }),
      { from: "a", to: ["b"], subject: "s", text: "t", headers: {} },
    );
    expect(r.phase).toBe("pre-data");
    expect(r.ok).toBe(false);
  });

  test("post-data error preserves classification", async () => {
    const err = Object.assign(new Error("dropped"), { code: "EPROTOCOL", responseCode: 451, response: "451 dropped after DATA" });
    const r = await sendViaSmtp(
      fake(async () => { throw err; }),
      { from: "a", to: ["b"], subject: "s", text: "t", headers: {} },
    );
    expect(r.phase).toBe("post-data");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement classifier**

```typescript
export type SmtpEnvelope = {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers: Readonly<Record<string, string>>;
};

export interface SmtpTransport {
  sendMail(env: SmtpEnvelope): Promise<{ readonly accepted: readonly string[]; readonly rejected: readonly string[]; readonly response: string }>;
}

export type SendResult =
  | { readonly phase: "pre-data"; readonly ok: false; readonly error: string }
  | { readonly phase: "post-data"; readonly ok: true }
  | { readonly phase: "post-data"; readonly ok: false; readonly error: string };

const PRE_DATA_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAUTH", "EENVELOPE", "ESOCKET"]);

export async function sendViaSmtp(t: SmtpTransport, env: SmtpEnvelope): Promise<SendResult> {
  try {
    const r = await t.sendMail(env);
    if (r.accepted.length > 0) return { phase: "post-data", ok: true };
    return { phase: "post-data", ok: false, error: `rejected: ${r.rejected.join(",")}` };
  } catch (e) {
    const code = (e as { code?: string }).code;
    const phase: "pre-data" | "post-data" = code && PRE_DATA_CODES.has(code) ? "pre-data" : "post-data";
    return { phase, ok: false, error: e instanceof Error ? e.message : String(e) } as SendResult;
  }
}
```

- [ ] **Step 3: Tests pass; commit**

```bash
git add packages/lib/channel-email/src/platform-send{,.test}.ts && \
git commit -m "feat(channel-email): add SMTP transport adapter with phase classification"
```

### Task 1.6: `email-channel.ts` — full state machine + factory

**Files:**
- Create: `packages/lib/channel-email/src/email-channel.ts`
- Create: `packages/lib/channel-email/src/email-channel.test.ts`
- Create: `packages/lib/channel-email/src/__tests__/integration.test.ts`

This is the largest file. Structure it under 400 lines by extracting subroutines. Key responsibilities:

1. `createEmailChannel(config, deps)` factory.
2. `connect()`: open IMAP IDLE, start handler worker, replay any `awaiting-recovery` outbox rows into `getPendingSends()`.
3. `disconnect()`: stop worker, close IMAP.
4. `send(message)`: run the 5-state outbound machine.
5. `onMessage(handler)`: register handler; the worker calls it.
6. `getPendingSends()` + `resolvePending(messageId, outcome)` operator APIs.

- [ ] **Step 1: Unit test the outbound state machine** — these tests use fakes for everything (transport, stores) and verify each transition path:
  - happy: `(none) → reserved → sending → sent`
  - pre-DATA fail: `reserved → sending → aborted` + thread rollback
  - post-DATA crash: `sending → awaiting-recovery` + thread blocked
  - resolvePending(sent): unblocks thread, future replies include the ID
  - resolvePending(failed): rolls back chain, future replies skip the ID
  - resolvePending conflict (concurrent reservation): returns `RECOVERY_CONFLICT`
  - resolvePending idempotency: same outcome twice → no-op; different outcome → `ALREADY_RESOLVED`
  - concurrent send same thread: CAS conflict → loser re-derives → both succeed with correct chains

- [ ] **Step 2: Confirm fail; implement; tests pass**

- [ ] **Step 3: Integration test** (`__tests__/integration.test.ts`) — full lifecycle with fake IMAP + SMTP + in-memory stores: connect → simulate inbound IMAP message → verify handler invoked → call `send()` → verify SMTP wrapper called with correct headers → verify outbox final status. Covers the IMAP UIDVALIDITY+UID idempotency path.

- [ ] **Step 4: Commit**

```bash
bun test packages/lib/channel-email && \
bun run lint && bun run typecheck && \
git add packages/lib/channel-email/src/email-channel{,.test}.ts \
        packages/lib/channel-email/src/__tests__/integration.test.ts && \
git commit -m "feat(channel-email): add createEmailChannel + outbound state machine"
```

### Task 1.7: `descriptor.ts` + `index.ts`

**Files:**
- Create: `packages/lib/channel-email/src/descriptor.ts` + test
- Create: `packages/lib/channel-email/src/index.ts`
- Create: `packages/lib/channel-email/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Descriptor test** — assert `EmailDescriptor` exposes the correct `name`, `capabilities`, `configSchema`. Pattern: copy `channel-slack` descriptor.

- [ ] **Step 2: Implement descriptor**

- [ ] **Step 3: Write `index.ts`** — public exports. Match the convention from `channel-slack/src/index.ts`. Re-export the factory, descriptor, all config types, all DI types, error codes.

- [ ] **Step 4: Write `api-surface.test.ts`** — snapshot of `Object.keys(await import("../index.js")).sort()`.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/channel-email/src/descriptor{,.test}.ts \
        packages/lib/channel-email/src/index.ts \
        packages/lib/channel-email/src/__tests__/api-surface.test.ts && \
git commit -m "feat(channel-email): add EmailDescriptor + public index"
```

---

## Phase 2 — `@koi/channel-teams` package

### Task 2.0: Package scaffolding + L2 doc

Same shape as Task 1.0. **Differences**:

- `package.json` deps: `jose@6.2.1` runtime; no devDeps beyond test-utils.
- `tsup` external: `["jose"]`.
- `docs/L2/channel-teams.md` covers: Bot Framework webhook, Adaptive Cards, JWT verification chain, `serviceUrlAllowlist`, `ConversationAddressStore`.

- [ ] **Step 1: Write package.json (with jose), tsconfig, tsup, doc; commit**

### Task 2.1: `config.ts` — `EmailConfigSchema`-style Zod schema with `cloud` + `serviceUrlAllowlist`

**Files:**
- Create: `packages/lib/channel-teams/src/config.ts` + test

- [ ] **Step 1: Tests**

```typescript
import { describe, expect, test } from "bun:test";
import { validateTeamsConfig } from "./config.js";

const valid = {
  appId: "00000000-0000-0000-0000-000000000000",
  appPassword: "secret",
  tenantAllowlist: ["my-tenant-id"],
  serviceUrlAllowlist: [
    { scheme: "https", host: "smba.trafficmanager.net", hostMatch: "subdomain" },
  ],
};

describe("validateTeamsConfig", () => {
  test("accepts public-cloud minimal config", () => {
    const r = validateTeamsConfig(valid);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.cloud).toBe("public");
  });

  test("rejects empty tenantAllowlist", () => {
    expect(validateTeamsConfig({ ...valid, tenantAllowlist: [] }).ok).toBe(false);
  });

  test("requires inline cloud to set both issuer + jwksUri", () => {
    expect(validateTeamsConfig({ ...valid, cloud: { issuer: "https://x" } }).ok).toBe(false);
    expect(validateTeamsConfig({ ...valid, cloud: { jwksUri: "https://x/jwks" } }).ok).toBe(false);
    expect(validateTeamsConfig({ ...valid, cloud: { issuer: "https://x", jwksUri: "https://x/jwks" } }).ok).toBe(true);
  });

  test("rejects scheme other than https", () => {
    expect(validateTeamsConfig({ ...valid, serviceUrlAllowlist: [{ scheme: "http", host: "x", hostMatch: "exact" }] }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement; tests pass; commit**

### Task 2.2: `verify-jwt.ts` — Bot Framework JWT verification with all 6 invariants

**Files:**
- Create: `packages/lib/channel-teams/src/verify-jwt.ts` + test

- [ ] **Step 1: Tests** — for each invariant: invalid signature → fail; aud mismatch → AUDIENCE_MISMATCH; tid not in allowlist → TENANT_NOT_ALLOWED; iss mismatch → INVALID_JWT; expired → INVALID_JWT; serviceUrl rejected per `ServiceUrlPattern` rules — both `exact` and `subdomain` matchers (positive + negative including the `evila.example.com` foot-gun).

- [ ] **Step 2: Implement** using `jose.jwtVerify` + `jose.createRemoteJWKSet`. ServiceUrl normalization: parse with `URL`, lowercase host, strip default port, compare per pattern.

- [ ] **Step 3: Tests pass; commit**

### Task 2.3: `normalize.ts` — Bot Framework Activity → InboundMessage

Same pattern as 1.3. Source: `archive/v1/packages/net/channel-teams/src/normalize.ts`.

### Task 2.4: `format.ts` — OutboundMessage → Adaptive Card

Same pattern as 1.4. Convert `ContentBlock[]` → adaptive-card v1.5 schema. Source: `archive/v1/packages/net/channel-teams`.

### Task 2.5: `platform-send.ts` — POST to `{address.serviceUrl}/v3/conversations/{id}/activities`

Same pattern as 1.5 but using `fetch`. Bearer token loaded from injected `tokenVerifier.appToken()`. Returns `Result<{ activityId: string }, KoiError>`.

### Task 2.6: `teams-channel.ts` — factory + `handleHttpRequest`

**Files:**
- Create: `packages/lib/channel-teams/src/teams-channel.ts` + test
- Create: `packages/lib/channel-teams/src/__tests__/integration.test.ts`

`handleHttpRequest` uses `handleWebhookIngress` from channel-base with:
- `verify`: calls `verify-jwt.ts`
- `extractKey`: `${channelId}|${tid}|${conversation.id}|${activity.id}`
- `parsePayload`: parse JSON, normalize, persist `ConversationAddress` via `conversationAddressStore.put` after JWT + serviceUrl verification.

`send(message)`:
1. Read `conversationAddressStore.get(message.threadId)`.
2. If null → return `Result<…, { code: "CONVERSATION_ADDRESS_UNKNOWN" }>`.
3. POST to `{address.serviceUrl}/v3/conversations/{id}/activities` with formatted payload.

Tests must include: AUDIENCE_MISMATCH path, SERVICE_URL_NOT_ALLOWED path, two messages with same `activity.id` but different `conversation.id` both dispatch.

### Task 2.7: `descriptor.ts` + `index.ts` + api-surface test

Same pattern as 1.7.

---

## Phase 3 — `@koi/channel-whatsapp` package

### Task 3.0: Package scaffolding

**Files:**
- Create: `packages/lib/channel-whatsapp/{package.json,tsconfig.json,tsup.config.ts}`
- Create: `docs/L2/channel-whatsapp.md`

`package.json` deps: only `@koi/channel-base` + `@koi/core`. No external SDKs (uses `fetch` + `Bun.CryptoHasher`). `tsup` external: `[]`.

### Task 3.1: `config.ts` — Zod schema for `{ phoneNumberId, accessToken, verifyToken, appSecret, graphBaseUrl? }`

Tests: required fields, default `graphBaseUrl: "https://graph.facebook.com/v18.0"`, reject empty appSecret.

### Task 3.2: `verify-signature.ts` — `X-Hub-Signature-256` HMAC over raw body

**Files:**
- Create: `packages/lib/channel-whatsapp/src/verify-signature.ts` + test

```typescript
import { describe, expect, test } from "bun:test";
import { verifyMetaSignature } from "./verify-signature.js";

const secret = "supersecret";
const body = '{"x":1}';

const sign = (s: string, b: string): string => {
  const h = new Bun.CryptoHasher("sha256", s);
  h.update(b);
  return `sha256=${h.digest("hex")}`;
};

describe("verifyMetaSignature", () => {
  test("matching signature passes", () => {
    expect(verifyMetaSignature({ rawBody: body, header: sign(secret, body), appSecret: secret }).ok).toBe(true);
  });
  test("mutated body fails", () => {
    const sig = sign(secret, body);
    expect(verifyMetaSignature({ rawBody: body + "x", header: sig, appSecret: secret }).ok).toBe(false);
  });
  test("missing header fails", () => {
    expect(verifyMetaSignature({ rawBody: body, header: undefined, appSecret: secret }).ok).toBe(false);
  });
  test("wrong secret fails", () => {
    expect(verifyMetaSignature({ rawBody: body, header: sign("other", body), appSecret: secret }).ok).toBe(false);
  });
});
```

Implement using `Bun.CryptoHasher` + `crypto.timingSafeEqual` on the resulting buffers.

### Task 3.3: `normalize.ts` — Meta Cloud API webhook → InboundMessage

Source: `archive/v1` does not exist (v1 used Baileys). Build from Meta Cloud API docs at `https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples`. Cover text, image, document, audio, location, button reply, list reply (latter two stubbed for v1 — pass through to `custom` block).

### Task 3.4: `format.ts` — OutboundMessage → Cloud API request body

Cover: text, template, image (URL-only), document (URL-only), audio (URL-only). Reject buttons/lists at format time with `UNSUPPORTED_BLOCK`.

### Task 3.5: `platform-send.ts` — POST `https://graph.facebook.com/v18.0/{phoneNumberId}/messages`

Bearer `accessToken`. Returns `Result<{ wamid: string }, KoiError>`.

### Task 3.6: `whatsapp-channel.ts` — factory + `handleHttpRequest`

Webhook handler:
- GET `?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` — handshake echoes `hub.challenge` only when `verify_token` matches config.
- POST — uses `handleWebhookIngress` with `verify` calling `verifyMetaSignature` over raw body, `extractKey` returning `${phone_number_id}|${messages[0].id}`.

Integration test must cover: GET handshake happy path + handshake rejects wrong token; POST with valid signature; POST with mutated body returns 401; duplicate `wamid` only emits once.

### Task 3.7: `descriptor.ts` + `index.ts` + api-surface test

---

## Phase 4 — Wire into `@koi/runtime` + golden queries

### Task 4.1: Add packages as `@koi/runtime` deps

**Files:**
- Modify: `packages/meta/runtime/package.json` (add three workspace deps)
- Modify: `packages/meta/runtime/tsconfig.json` (add three project refs)

- [ ] **Step 1: Edit package.json** — add to `dependencies`:

```json
"@koi/channel-email": "workspace:*",
"@koi/channel-teams": "workspace:*",
"@koi/channel-whatsapp": "workspace:*"
```

- [ ] **Step 2: Edit tsconfig.json** — add three `{ "path": "../../lib/channel-..." }` to `references`.

- [ ] **Step 3: Run `bun install --frozen-lockfile`; confirm clean**

- [ ] **Step 4: Run `bun run check:orphans`; confirm three new packages no longer flagged**

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/{package.json,tsconfig.json} && \
git commit -m "feat(runtime): wire channel-email, channel-teams, channel-whatsapp as deps"
```

### Task 4.2: Add 2 golden queries per package

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

Append three new `describe("Golden: @koi/channel-...", ...)` blocks. Each block has 2 test cases (per CLAUDE.md "Standalone: Add 2 per-L2 golden queries"):

For each channel:
1. **Construct + descriptor**: import factory and descriptor, build channel with in-memory stores (test mode), assert `descriptor.name` and that `channel.connect/disconnect/send/onMessage` are functions; for webhook channels also assert `typeof channel.handleHttpRequest === "function"`.
2. **Inbound normalize round-trip**: feed a captured platform fixture JSON file (committed as `packages/meta/runtime/fixtures/<channel>.inbound.json`) → call internal normalize via the channel's `handleHttpRequest` (with auth bypassed using a test-only DI override) → assert the `InboundMessage` shape matches a stored snapshot.

- [ ] **Step 1: Add fixtures** — three small JSON files under `fixtures/`:
  - `email.inbound.json` — minimal RFC 5322 message
  - `teams.inbound.json` — minimal Bot Framework activity
  - `whatsapp.inbound.json` — minimal Meta Cloud API entry

- [ ] **Step 2: Add the 6 test cases** in the order matching existing `channel-slack` block at line ~2811. Use the same import shape (`const { createEmailChannel } = await import("@koi/channel-email");`).

- [ ] **Step 3: Run `bun run test --filter=@koi/runtime` — confirm PASS**

- [ ] **Step 4: Run `bun run check:golden-queries` — confirm three packages now have golden assertions**

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/src/__tests__/golden-replay.test.ts \
        packages/meta/runtime/fixtures/{email,teams,whatsapp}.inbound.json && \
git commit -m "test(runtime): golden queries for channel-email, channel-teams, channel-whatsapp"
```

### Task 4.3: Final CI gate sweep

- [ ] **Step 1: Run full local CI**

```bash
bun run test && \
bun run typecheck && \
bun run lint && \
bun run check:layers && \
bun run check:unused && \
bun run check:duplicates && \
bun run check:orphans && \
bun run check:golden-queries
```

  All must exit 0. If any fails, fix the root cause before proceeding (per CLAUDE.md "No Laziness").

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat: enterprise channels (email + teams + whatsapp) — closes #1363" \
  --body "$(cat <<'EOF'
## Summary

Three new L2 channel packages closing #1363:

- `@koi/channel-email` — IMAP IDLE inbound + SMTP outbound with durable RFC 5322 threading
- `@koi/channel-teams` — Bot Framework webhook with full JWT verification chain
- `@koi/channel-whatsapp` — Meta Cloud API webhook (replaces v1 Baileys)

Shared store interfaces (IdempotencyStore, IngressQueue, ThreadStore, OutboxStore, ConversationAddressStore, HandlerWorker, handleWebhookIngress) added to `@koi/channel-base`.

Design hardened across 10 rounds of adversarial review — see `docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md`.

## Test plan

- [ ] Unit: each store interface, normalize/format/platform-send/threading per channel
- [ ] Integration: full handshake → receive → handler → send round-trip per channel
- [ ] Golden queries: 2 per channel in `@koi/runtime`
- [ ] CI: typecheck, lint, check:layers, check:orphans, check:golden-queries

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist (run before handoff)

- **Spec coverage**: every required component in the spec has a corresponding task — Phase 0 covers all five store interfaces + handler worker + webhook helper; Phases 1/2/3 each cover descriptor, config, normalize, format, platform-send, channel/state-machine, integration, descriptor+index. Phase 4 covers runtime wiring + golden queries. ✅
- **Placeholder scan**: tasks 2.3–2.7 and 3.3–3.7 reference earlier patterns rather than re-quoting them. This is acceptable per the plan style above (full code is in Phase 1 templates), but each MUST produce its own concrete tests + impl when executed. ✅
- **Type consistency**: `Lease`, `TryBeginResult`, `QueueItem`, `ThreadState`, `OutboxRecord`, `ConversationAddress`, `IngressQueue` all defined in Phase 0 and consumed by every channel package via re-export from `@koi/channel-base`. No naming drift. ✅
- **Inferred dependency**: `zod` may need adding to `channel-email`/`channel-teams`/`channel-whatsapp` package.json — Task 1.1 step 3 includes the verification step.
- **CLAUDE.md compliance**: each file < 400 lines (state machine extracted into helpers), each function < 50 lines, Doc → Tests → Code, no `enum`/`namespace`/`any`/`as`/`!`, ESM-only with `.js` extensions, all `readonly`. ✅
