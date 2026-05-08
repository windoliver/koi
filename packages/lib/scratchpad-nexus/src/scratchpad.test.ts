import { describe, expect, test } from "bun:test";
import type {
  KoiError,
  Result,
  ScratchpadChangeEvent,
  ScratchpadComponent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadWriteResult,
} from "@koi/core";
import { agentGroupId, agentId, scratchpadPath } from "@koi/core";
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
  const entries = new Map<string, ScratchpadEntry>();

  return {
    write: (input) => {
      const now = "2026-05-07T00:00:00.000Z";
      const nextGeneration = (entries.get(input.path)?.generation ?? 0) + 1;
      const entry: ScratchpadEntry = {
        path: input.path,
        content: input.content,
        generation: nextGeneration,
        groupId: agentGroupId("group-a"),
        authorId: agentId("agent-a"),
        createdAt: now,
        updatedAt: now,
        sizeBytes: input.content.length,
      };
      entries.set(entry.path, entry);
      const result: ScratchpadWriteResult = {
        path: entry.path,
        generation: entry.generation,
        sizeBytes: entry.sizeBytes,
      };
      return { ok: true, value: result };
    },
    read: (path) => {
      const entry = entries.get(path);
      if (entry === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "missing", retryable: false } satisfies KoiError,
        };
      }
      return { ok: true, value: entry };
    },
    list: () => {
      const summaries: readonly ScratchpadEntrySummary[] = [...entries.values()].map((entry) => ({
        path: entry.path,
        content: entry.content,
        generation: entry.generation,
        groupId: entry.groupId,
        authorId: entry.authorId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        sizeBytes: entry.sizeBytes,
      }));
      return summaries;
    },
    delete: (path) => {
      entries.delete(path);
      return { ok: true, value: undefined };
    },
    flush: () => {},
    onChange: () => () => {},
  };
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
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false },
        };
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

  test("write rejects non-JSON-serializable metadata before crossing the RPC boundary", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    let writeCalls = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "scratchpad.write") {
          writeCalls += 1;
          return { ok: true, value: { path: "x", generation: 1, sizeBytes: 1 } as T };
        }
        return { ok: true, value: {} as T };
      }),
    });

    // Circular references break JSON.stringify — must be caught locally
    // rather than failing deep inside transport serialization.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await scratchpad.write({
      path: scratchpadPath("notes.txt"),
      content: "ok",
      metadata: circular,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    expect(writeCalls).toBe(0);
  });

  test("write rejects entries that exceed the contract size limit before crossing the RPC boundary", async () => {
    const { createNexusScratchpad } = await import("./index.js");
    const { SCRATCHPAD_DEFAULTS } = await import("@koi/core");

    let writeCalls = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "scratchpad.write") {
          writeCalls += 1;
          return { ok: true, value: { path: "x", generation: 1, sizeBytes: 1 } as T };
        }
        return { ok: true, value: {} as T };
      }),
    });

    const oversized = "x".repeat(SCRATCHPAD_DEFAULTS.MAX_FILE_SIZE_BYTES + 1);
    const result = await scratchpad.write({
      path: scratchpadPath("big.bin"),
      content: oversized,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    expect(writeCalls).toBe(0);
  });

  test("does NOT swap to a local store on a failed startup health probe", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // Returning a local fallback when the generic probe fails would let
    // this instance read/write only the local store while other
    // participants kept hitting Nexus, producing silent divergence and
    // effective data loss for the caller. Errors propagate instead.
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
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
    expect(result.ok).toBe(false);
  });

  test("runtime failure does NOT swap the storage authority to the fallback", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // The two backends do not share state, so silently rerouting reads/
    // writes to fallback after a transient blip would fork the source of
    // truth — Nexus would still hold the real entries while callers see
    // an empty local store. Errors must propagate; fallback is reserved
    // for the up-front health probe.
    let nexusWriteCalls = 0;
    let fallbackWriteCalls = 0;
    const _unusedFallback: ScratchpadComponent = {
      ...createFallbackScratchpad(),
      write: async () => {
        fallbackWriteCalls += 1;
        return {
          ok: true,
          value: { path: scratchpadPath("ignored.txt"), generation: 1, sizeBytes: 2 },
        };
      },
    };
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "scratchpad.write") {
          nexusWriteCalls += 1;
          if (nexusWriteCalls === 1) {
            return { ok: false, error: { code: "EXTERNAL", message: "blip", retryable: true } };
          }
          return { ok: true, value: { path: "b.txt", generation: 1, sizeBytes: 2 } as T };
        }
        return { ok: true, value: {} as T };
      }),
    });

    const first = await scratchpad.write({ path: scratchpadPath("a.txt"), content: "aa" });
    expect(first.ok).toBe(false);

    const second = await scratchpad.write({ path: scratchpadPath("b.txt"), content: "bb" });
    expect(second.ok).toBe(true);
    expect(nexusWriteCalls).toBe(2);
    expect(fallbackWriteCalls).toBe(0);
  });

  test("onChange emits unseen writes once", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    let calls = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
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
});

describe("createChangeTracker", () => {
  test("emits a deleted event when an entry disappears", async () => {
    const { createChangeTracker } = await import("./change-tracker.js");
    const tracker = createChangeTracker("group-a");

    const initial: ScratchpadEntrySummary[] = [
      {
        path: scratchpadPath("notes.txt"),
        generation: 1,
        groupId: agentGroupId("group-a"),
        authorId: agentId("agent-a"),
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
        sizeBytes: 5,
      },
    ];
    const firstEvents = tracker.nextEvents(initial);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]?.kind).toBe("written");

    const afterDelete = tracker.nextEvents([]);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.kind).toBe("deleted");
    expect(afterDelete[0]?.path).toBe(scratchpadPath("notes.txt"));
    expect(afterDelete[0]?.generation).toBe(1);
  });

  test("emits a delete event when a sustained full-page collection drops one entry, paginated", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const PAGE_SIZE = 2;
    let callCount = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      pageSize: PAGE_SIZE,
      transport: createHealthyTransport(
        async <T>(
          method: string,
          params: Record<string, unknown>,
        ): Promise<Result<T, KoiError>> => {
          if (method !== "scratchpad.list") {
            return {
              ok: false,
              error: { code: "EXTERNAL", message: "unexpected", retryable: false },
            };
          }
          const cursor = params.cursor as string | undefined;
          callCount += 1;
          // Two snapshots, both exactly pageSize-long across two pages each.
          // Snapshot 1: [a.txt, b.txt] then [c.txt]      → all 3 paths present.
          // Snapshot 2: [a.txt, b.txt] then []           → c.txt deleted.
          const snapshotIndex = Math.floor((callCount - 1) / 2);
          const isFirstPage = cursor === undefined;
          const baseEntry = (path: string) => ({
            path,
            generation: 1,
            groupId: "group-a",
            authorId: "agent-a",
            createdAt: "2026-05-07T00:00:00.000Z",
            updatedAt: "2026-05-07T00:00:00.000Z",
            sizeBytes: 1,
          });
          if (snapshotIndex === 0 && isFirstPage) {
            return {
              ok: true,
              value: { entries: [baseEntry("a.txt"), baseEntry("b.txt")], nextCursor: "p2" } as T,
            };
          }
          if (snapshotIndex === 0 && !isFirstPage) {
            return { ok: true, value: { entries: [baseEntry("c.txt")] } as T };
          }
          if (isFirstPage) {
            return {
              ok: true,
              value: { entries: [baseEntry("a.txt"), baseEntry("b.txt")], nextCursor: "p2" } as T,
            };
          }
          return { ok: true, value: { entries: [] } as T };
        },
      ),
    });

    const events: Array<{ kind: string; path: string }> = [];
    const unsubscribe = scratchpad.onChange((event) =>
      events.push({ kind: event.kind, path: event.path }),
    );
    await Bun.sleep(40);
    unsubscribe();

    expect(events.some((e) => e.kind === "deleted" && e.path === "c.txt")).toBe(true);
  });

  test("treats a single-page response with exactly pageSize entries as exhaustive", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const PAGE_SIZE = 2;
    let snapshotIndex = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      pageSize: PAGE_SIZE,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        snapshotIndex += 1;
        const baseEntry = (path: string) => ({
          path,
          generation: 1,
          groupId: "group-a",
          authorId: "agent-a",
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          sizeBytes: 1,
        });
        // Snapshot 1: exactly pageSize entries, no nextCursor → exhaustive.
        // Snapshot 2: one of those entries is gone, still no nextCursor →
        // the missing path must be reported as deleted, even though snapshot 1
        // landed on exactly pageSize entries.
        if (snapshotIndex === 1) {
          return {
            ok: true,
            value: { entries: [baseEntry("a.txt"), baseEntry("b.txt")] } as T,
          };
        }
        return { ok: true, value: { entries: [baseEntry("a.txt")] } as T };
      }),
    });

    const deleted: string[] = [];
    const unsubscribe = scratchpad.onChange((event) => {
      if (event.kind === "deleted") deleted.push(event.path);
    });
    await Bun.sleep(40);
    unsubscribe();

    expect(deleted).toContain("b.txt");
  });

  test("polling failures do NOT swap subscribers onto the fallback (no hand-off)", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // Reroute would fork the source of truth: Nexus may still be holding
    // the real entries while the fallback is empty. The poll just misses
    // a tick and tries again next interval; subscribers stay bound to
    // Nexus and resume delivery once Nexus recovers.
    const fallbackHandlers = new Set<(event: ScratchpadChangeEvent) => void>();
    const baseFallback = createFallbackScratchpad();
    const fallback = {
      ...baseFallback,
      onChange: (handler: (event: ScratchpadChangeEvent) => void) => {
        fallbackHandlers.add(handler);
        return () => {
          fallbackHandlers.delete(handler);
        };
      },
    };

    let listCalls = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        listCalls += 1;
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "list down", retryable: false },
        };
      }),
    });

    const events: ScratchpadChangeEvent[] = [];
    const unsubscribe = scratchpad.onChange((event) => events.push(event));
    await Bun.sleep(40);

    // Subscriber stays on Nexus; fallback was never asked to take over.
    expect(fallbackHandlers.size).toBe(0);
    // Polls keep firing — the failing tick is a missed round, not a state change.
    expect(listCalls).toBeGreaterThan(1);
    expect(events).toHaveLength(0);

    unsubscribe();
  });

  test("does not interleave overlapping polls when a poll outruns the interval", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    let inFlight = 0;
    let maxInFlight = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      pageSize: 10,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Intentionally slow so the next interval fires while we are still draining.
        await Bun.sleep(30);
        inFlight -= 1;
        return { ok: true, value: { entries: [] } as T };
      }),
    });

    const unsubscribe = scratchpad.onChange(() => {});
    await Bun.sleep(80);
    unsubscribe();

    // With proper serialization, only one poll runs at a time even though the
    // 5ms interval fires multiple times during a 30ms list call.
    expect(maxInFlight).toBe(1);
  });

  test("scratchpad.list() drains nextCursor pages instead of silently truncating", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pageSize: 2,
      transport: createHealthyTransport(
        async <T>(
          method: string,
          params: Record<string, unknown>,
        ): Promise<Result<T, KoiError>> => {
          if (method !== "scratchpad.list") {
            return {
              ok: false,
              error: { code: "EXTERNAL", message: "unexpected", retryable: false },
            };
          }
          const baseEntry = (path: string) => ({
            path,
            generation: 1,
            groupId: "group-a",
            authorId: "agent-a",
            createdAt: "2026-05-07T00:00:00.000Z",
            updatedAt: "2026-05-07T00:00:00.000Z",
            sizeBytes: 1,
          });
          if (params.cursor === undefined) {
            return {
              ok: true,
              value: { entries: [baseEntry("a.txt"), baseEntry("b.txt")], nextCursor: "p2" } as T,
            };
          }
          return { ok: true, value: { entries: [baseEntry("c.txt")] } as T };
        },
      ),
    });

    const all = await scratchpad.list();
    expect(all.map((entry) => entry.path)).toEqual([
      scratchpadPath("a.txt"),
      scratchpadPath("b.txt"),
      scratchpadPath("c.txt"),
    ]);
  });

  test("trusts an absent nextCursor as authoritative even at exact-page-multiple snapshots", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // Previously the adapter required `lastPageSize < pageSize` to treat
    // a snapshot as exhaustive — so a group containing exactly pageSize
    // entries never produced delete events. The cursor contract is the
    // source of truth: when the server returns no `nextCursor` after a
    // successful drain, the snapshot IS authoritative.
    const PAGE_SIZE = 2;
    let snapshotIndex = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      pageSize: PAGE_SIZE,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        snapshotIndex += 1;
        const baseEntry = (path: string) => ({
          path,
          generation: 1,
          groupId: "group-a",
          authorId: "agent-a",
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          sizeBytes: 1,
        });
        if (snapshotIndex === 1) {
          return {
            ok: true,
            value: { entries: [baseEntry("a.txt"), baseEntry("b.txt")] } as T,
          };
        }
        return { ok: true, value: { entries: [baseEntry("a.txt"), baseEntry("c.txt")] } as T };
      }),
    });

    const deleted: string[] = [];
    const unsubscribe = scratchpad.onChange((event) => {
      if (event.kind === "deleted") deleted.push(event.path);
    });
    await Bun.sleep(40);
    unsubscribe();

    expect(deleted).toContain("b.txt");
  });

  test("scratchpad.list throws on transport failure rather than masking outage as empty", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "list down", retryable: false },
          };
        }
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false },
        };
      }),
    });

    let caught: unknown;
    try {
      await scratchpad.list();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Nexus scratchpad list failed/);
  });

  test("scratchpad.list throws when the server returns a repeating pagination cursor", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pageSize: 2,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        // Always returns the same nextCursor — a buggy server stuck in a loop.
        return {
          ok: true,
          value: {
            entries: [
              {
                path: "a.txt",
                generation: 1,
                groupId: "group-a",
                authorId: "agent-a",
                createdAt: "2026-05-07T00:00:00.000Z",
                updatedAt: "2026-05-07T00:00:00.000Z",
                sizeBytes: 1,
              },
            ],
            nextCursor: "stuck",
          } as T,
        };
      }),
    });

    let caught: unknown;
    try {
      await scratchpad.list();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/repeating pagination cursor/);
  });

  test("polling treats a broken pagination round as a missed tick (does not wedge or fork state)", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // Per-poll guards (repeating cursor, max pages) bound a single round so
    // a misbehaving server cannot wedge the loop, but the timer keeps
    // running so polling resumes once the server recovers — a transient
    // pagination glitch must not permanently disable change delivery.
    let listCalls = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      pageSize: 1,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        listCalls += 1;
        return {
          ok: true,
          value: {
            entries: [
              {
                path: "a.txt",
                generation: 1,
                groupId: "group-a",
                authorId: "agent-a",
                createdAt: "2026-05-07T00:00:00.000Z",
                updatedAt: "2026-05-07T00:00:00.000Z",
                sizeBytes: 1,
              },
            ],
            nextCursor: "stuck",
          } as T,
        };
      }),
    });

    const events: ScratchpadChangeEvent[] = [];
    const unsubscribe = scratchpad.onChange((event) => events.push(event));
    await Bun.sleep(40);
    const callsAfterFirstWindow = listCalls;
    await Bun.sleep(40);
    unsubscribe();

    // Polls keep firing across the broken pagination — the guard prevents
    // a single round from looping, but the timer is preserved so recovery
    // is automatic. Crucially, no events were delivered: a broken
    // pagination round must not be mistaken for an authoritative snapshot.
    expect(callsAfterFirstWindow).toBeGreaterThan(0);
    expect(listCalls).toBeGreaterThan(callsAfterFirstWindow);
    expect(events).toHaveLength(0);
  });
});
