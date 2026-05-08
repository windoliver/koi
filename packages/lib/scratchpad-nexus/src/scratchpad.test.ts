import { describe, expect, test } from "bun:test";
import type {
  AgentGroupId,
  AgentId,
  KoiError,
  Result,
  ScratchpadComponent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadWriteInput,
  ScratchpadWriteResult,
} from "../../../kernel/core/src/index.js";
import { agentGroupId, agentId, scratchpadPath } from "../../../kernel/core/src/index.js";
import type { NexusTransport } from "../../../lib/nexus-client/src/index.js";

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
