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

  test("hands existing onChange subscribers off to the fallback when polling degrades", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // Fallback whose onChange actively fires events so we can prove the
    // subscription was rebound, not silently dropped.
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

    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      fallback,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method !== "scratchpad.list") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "unexpected", retryable: false },
          };
        }
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "list down", retryable: false },
        };
      }),
    });

    const events: ScratchpadChangeEvent[] = [];
    const unsubscribe = scratchpad.onChange((event) => events.push(event));
    // Wait for the failing poll to fire and degrade.
    await Bun.sleep(40);

    expect(fallbackHandlers.size).toBe(1);

    // Simulate the fallback emitting a change — the original handler must receive it.
    for (const handler of fallbackHandlers) {
      handler({
        kind: "written",
        path: scratchpadPath("after.txt"),
        generation: 1,
        authorId: agentId("agent-a"),
        groupId: agentGroupId("group-a"),
        timestamp: "2026-05-07T00:00:00.000Z",
      });
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe(scratchpadPath("after.txt"));

    unsubscribe();
    expect(fallbackHandlers.size).toBe(0);
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

  test("does not synthesize false deletes against legacy servers that ignore nextCursor", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // Legacy server: ignores cursor field, always returns first page only,
    // never sets nextCursor. With the default `serverSupportsPagination: false`
    // we must not announce the missing entries as deletions just because they
    // fell off the first page.
    const PAGE_SIZE = 2;
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
        const baseEntry = (path: string) => ({
          path,
          generation: 1,
          groupId: "group-a",
          authorId: "agent-a",
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          sizeBytes: 1,
        });
        // Always returns exactly pageSize entries; legacy server hides the rest.
        return {
          ok: true,
          value: { entries: [baseEntry("a.txt"), baseEntry("b.txt")] } as T,
        };
      }),
    });

    const events: ScratchpadChangeEvent[] = [];
    const unsubscribe = scratchpad.onChange((event) => events.push(event));
    await Bun.sleep(40);
    unsubscribe();

    // Writes for a.txt/b.txt are fine on the first poll; subsequent polls
    // observe the same entries with the same generation, so no further events.
    expect(events.every((event) => event.kind === "written")).toBe(true);
  });

  test("trusts nextCursor exhaustiveness when serverSupportsPagination is opted in", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    const PAGE_SIZE = 2;
    let snapshotIndex = 0;
    const scratchpad = await createNexusScratchpad({
      groupId: agentGroupId("group-a"),
      authorId: agentId("agent-a"),
      pollIntervalMs: 5,
      pageSize: PAGE_SIZE,
      serverSupportsPagination: true,
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
        // Both snapshots are exactly pageSize entries with no nextCursor; the
        // opt-in flag tells us to trust that as exhaustive, so when b.txt drops
        // on snapshot 2 the tracker must emit a delete event.
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

  test("polling stops the timer when pagination is broken and no fallback is configured", async () => {
    const { createNexusScratchpad } = await import("./index.js");

    // No fallback. A repeating-cursor server would otherwise wedge polling
    // forever; the guards must stop the timer and surface the failure rather
    // than silently looping over a broken endpoint.
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

    const unsubscribe = scratchpad.onChange(() => {});
    await Bun.sleep(40);
    const callsAfterFirstWindow = listCalls;
    await Bun.sleep(40);
    unsubscribe();

    // After the guard trips and the timer is stopped, list-call count must
    // not keep climbing.
    expect(listCalls).toBe(callsAfterFirstWindow);
  });
});
