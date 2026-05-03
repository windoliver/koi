import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { Session } from "@koi/gateway-types";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusSessionStore } from "./nexus-session-store.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-1",
    agentId: "a-1",
    connectedAt: 100,
    lastHeartbeat: 200,
    seq: 1,
    remoteSeq: 0,
    metadata: {},
    ...overrides,
  };
}

type Handler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Result<unknown, KoiError>>;

function makeTransport(handler: Handler): {
  transport: NexusTransport;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    transport: {
      kind: "http",
      call: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        calls.push({ method, params });
        return handler(method, params) as Promise<Result<T, KoiError>>;
      },
      close: () => {},
    },
    calls,
  };
}

/**
 * Wrap a per-path read_bulk response — the helper unwraps `value[path]`,
 * so the mock has to key its payload off the path the caller asked for.
 */
function readBulkResponse(
  params: Record<string, unknown>,
  envelope: unknown,
): Result<unknown, KoiError> {
  const paths = (params as { paths: readonly string[] }).paths;
  return { ok: true, value: { [paths[0] ?? ""]: envelope } };
}

function deleteBatchOk(params: Record<string, unknown>): Result<unknown, KoiError> {
  const paths = (params as { paths: readonly string[] }).paths;
  return { ok: true, value: { [paths[0] ?? ""]: { success: true } } };
}

function writePath(params: Record<string, unknown>): string {
  const files = (params as { files: ReadonlyArray<readonly [string, unknown]> }).files;
  return files[0]?.[0] ?? "";
}

describe("nexus session store", () => {
  test("set caches locally and queues immediate write for new session", async () => {
    const { transport, calls } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({ transport });
    const r = await handle.store.set(session());
    expect(r.ok).toBe(true);
    // immediate write fires without flush
    await new Promise<void>((res) => setTimeout(res, 10));
    expect(calls.find((c) => c.method === "write_batch")).toBeDefined();
    await handle.dispose();
  });

  test("get returns cached session synchronously", async () => {
    const { transport } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({ transport });
    await handle.store.set(session({ id: "s-2" }));
    const r = handle.store.get("s-2");
    // sync return on cache hit
    expect(r instanceof Promise).toBe(false);
    const settled = (await Promise.resolve(r)) as Result<Session, KoiError>;
    expect(settled.ok).toBe(true);
  });

  test("get falls through to nexus on cache miss", async () => {
    const record = {
      session: session({ id: "remote-1" }),
      ownerInstance: "other",
      ownedSince: 1,
      version: 1,
    };
    const { transport } = makeTransport(async (method, params) => {
      if (method === "read_bulk")
        return readBulkResponse(params, { content: JSON.stringify(record) });
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({ transport });
    const r = await handle.store.get("remote-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("remote-1");
    // should now be cached
    const r2 = handle.store.get("remote-1");
    expect(r2 instanceof Promise).toBe(false);
  });

  test("get on nexus NOT_FOUND returns notFound error", async () => {
    // read_bulk's NOT_FOUND signal is in-band: result[path] === null.
    const { transport } = makeTransport(async (_method, params) => {
      const paths = (params as { paths: readonly string[] }).paths;
      return { ok: true, value: { [paths[0] ?? ""]: null } };
    });
    const handle = createNexusSessionStore({ transport });
    const r = await handle.store.get("ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("degraded reads short-circuit (no nexus call, EXTERNAL not NOT_FOUND)", async () => {
    let readCount = 0;
    const { transport } = makeTransport(async (method) => {
      if (method === "read_bulk") {
        readCount++;
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "boom", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
        };
      }
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({
      transport,
      // High probe interval so the second miss is still cooling down.
      config: { degradation: { failureThreshold: 1, probeIntervalMs: 60_000 } },
    });
    // first miss flips to degraded
    await handle.store.get("a");
    expect(handle.degradation().mode).toBe("degraded");
    // subsequent miss does not call nexus and surfaces EXTERNAL so callers can
    // distinguish "Nexus unavailable" from "session truly absent".
    const r = await handle.store.get("b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
    expect(readCount).toBe(1);
  });

  test("delete removes from cache and fires async nexus delete", async () => {
    const { transport, calls } = makeTransport(async (method, params) => {
      if (method === "delete_batch") return deleteBatchOk(params);
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({ transport });
    await handle.store.set(session({ id: "s-del" }));
    const r = await handle.store.delete("s-del");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);
    await new Promise<void>((res) => setTimeout(res, 10));
    expect(calls.some((c) => c.method === "delete_batch")).toBe(true);
    await handle.dispose();
  });

  test("entries iterates local cache", async () => {
    const { transport } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({ transport });
    await handle.store.set(session({ id: "s-1" }));
    await handle.store.set(session({ id: "s-2" }));
    const ids = [...handle.store.entries()].map(([id]) => id).sort();
    expect(ids).toEqual(["s-1", "s-2"]);
    expect(handle.store.size()).toBe(2);
  });

  test("get returns VALIDATION error when nexus payload shape is bad", async () => {
    const { transport } = makeTransport(async (method, params) => {
      if (method === "read_bulk") return readBulkResponse(params, { unexpected: "shape" });
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({ transport });
    const r = await handle.store.get("ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("has() reflects local cache state", async () => {
    const { transport } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({ transport });
    expect((await handle.store.has("absent")).ok).toBe(true);
    const empty = await handle.store.has("absent");
    if (empty.ok) expect(empty.value).toBe(false);
    await handle.store.set(session({ id: "present" }));
    const present = await handle.store.has("present");
    if (present.ok) expect(present.value).toBe(true);
    await handle.dispose();
  });

  test("write failure flips degradation", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method === "write_batch") {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
        };
      }
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({
      transport,
      config: { degradation: { failureThreshold: 1 } },
    });
    await handle.store.set(session({ id: "wf" }));
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(handle.degradation().mode).toBe("degraded");
    await handle.dispose();
  });

  test("delete failure flips degradation", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method === "delete_batch") {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
        };
      }
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({
      transport,
      config: { degradation: { failureThreshold: 1 } },
    });
    await handle.store.set(session({ id: "df" }));
    await new Promise<void>((res) => setTimeout(res, 10));
    await handle.store.delete("df");
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(handle.degradation().mode).toBe("degraded");
    await handle.dispose();
  });

  test("delete throws → catch path flips degradation", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method === "delete_batch") throw new Error("network down");
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({
      transport,
      config: { degradation: { failureThreshold: 1 } },
    });
    await handle.store.set(session({ id: "throwy" }));
    await handle.store.delete("throwy");
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(handle.degradation().mode).toBe("degraded");
    await handle.dispose();
  });

  test("path encoding sanitizes session id", async () => {
    const { transport, calls } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({
      transport,
      config: { basePath: "x/y" },
    });
    await handle.store.set(session({ id: "weird/id with..stuff" }));
    await new Promise<void>((res) => setTimeout(res, 10));
    const writeCall = calls.find((c) => c.method === "write_batch");
    expect(writeCall).toBeDefined();
    const path = writePath(writeCall?.params ?? {});
    expect(path.startsWith("x/y/")).toBe(true);
    expect(path).not.toContain("..");
    await handle.dispose();
  });

  test("distinct ids never collide on the same Nexus path", async () => {
    const { transport, calls } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({ transport, config: { basePath: "p" } });
    // These would collide under naive `_`-replacement but must stay distinct
    // under reversible base64url encoding.
    const ids = ["a/b", "a b", "a_b", "a+b", "a/b/", "a"];
    for (const id of ids) await handle.store.set(session({ id }));
    await new Promise<void>((res) => setTimeout(res, 10));
    const writePaths = calls
      .filter((c) => c.method === "write_batch")
      .map((c) => writePath(c.params));
    const unique = new Set(writePaths);
    expect(unique.size).toBe(ids.length);
    await handle.dispose();
  });

  test("delete returns awaited Result (not a fire-and-forget undefined)", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method === "delete_batch") {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "boom", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
        };
      }
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({ transport });
    await handle.store.set(session({ id: "real" }));
    await new Promise<void>((res) => setTimeout(res, 10));
    const r = await handle.store.delete("real");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
    await handle.dispose();
  });

  test("dispose drains in-flight delete before resolving", async () => {
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((res) => {
      releaseDelete = res;
    });
    let deleteCompleted = false;
    const { transport } = makeTransport(async (method, params) => {
      if (method === "delete_batch") {
        await deleteGate;
        deleteCompleted = true;
        return deleteBatchOk(params);
      }
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({ transport });
    await handle.store.set(session({ id: "drain" }));
    void handle.store.delete("drain");
    // Kick off dispose while the delete is still pending.
    const disposeP = handle.dispose();
    expect(deleteCompleted).toBe(false);
    releaseDelete();
    await disposeP;
    expect(deleteCompleted).toBe(true);
  });

  test("degraded probe recovery: cache miss after probe interval flips back to healthy", async () => {
    let phase: "fail" | "ok" = "fail";
    const record = {
      session: session({ id: "recovered" }),
      ownerInstance: "other",
      ownedSince: 1,
      version: 1,
    };
    const { transport } = makeTransport(async (method, params) => {
      if (method !== "read_bulk") return { ok: true, value: undefined };
      if (phase === "fail") {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: "boom", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
        };
      }
      return readBulkResponse(params, { content: JSON.stringify(record) });
    });
    const handle = createNexusSessionStore({
      transport,
      config: {
        degradation: { failureThreshold: 1, probeIntervalMs: 5 },
      },
    });
    await handle.store.get("recovered"); // flip to degraded
    expect(handle.degradation().mode).toBe("degraded");

    // Repair Nexus and wait past the probe interval.
    phase = "ok";
    await new Promise<void>((res) => setTimeout(res, 12));
    const r = await handle.store.get("recovered");
    expect(r.ok).toBe(true);
    expect(handle.degradation().mode).toBe("healthy");
    await handle.dispose();
  });

  test("rejects empty session id (no shared Nexus path collision)", async () => {
    // Round-2 finding 6: nexusPath("") encodes to "", aliasing every empty-id
    // session onto a single Nexus record. Reject at the boundary so a buggy
    // authenticator cannot poison the namespace.
    const { transport, calls } = makeTransport(async () => ({ ok: true, value: undefined }));
    const handle = createNexusSessionStore({ transport });
    const setR = await handle.store.set(session({ id: "" }));
    expect(setR.ok).toBe(false);
    if (!setR.ok) expect(setR.error.code).toBe("VALIDATION");
    const getR = await handle.store.get("");
    expect(getR.ok).toBe(false);
    const delR = await handle.store.delete("");
    expect(delR.ok).toBe(false);
    // Crucially, no Nexus traffic was issued for the empty id.
    expect(calls.length).toBe(0);
    await handle.dispose();
  });

  test("delete waits for in-flight successful write so it cannot resurrect the record (round-3 fix 1)", async () => {
    // The hardest case: the write is going to SUCCEED at Nexus but lands AFTER
    // delete is called. Without serialization, network ordering would be
    // write→delete→(stale write succeeds)→delete-succeeds — leaving a ghost
    // record because the "delete completed" point is observed before the
    // late write ack. With drainPath the delete waits for the write to
    // settle, then issues the remote delete, so Nexus is empty.
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((res) => {
      releaseWrite = res;
    });
    const events: string[] = [];
    const { transport } = makeTransport(async (method, params) => {
      if (method === "write_batch") {
        await writeGate;
        events.push("write-succeeded");
        return { ok: true, value: undefined };
      }
      if (method === "delete_batch") {
        events.push("delete-issued");
        return deleteBatchOk(params);
      }
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({ transport });
    await handle.store.set(session({ id: "race" })); // immediate write, gated
    const delP = handle.store.delete("race");
    // Yield so delete reaches the drainPath await.
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(events).toEqual([]); // delete is correctly waiting on the write
    releaseWrite();
    const r = await delP;
    expect(r.ok).toBe(true);
    // Crucially: write completed BEFORE delete issued the remote delete.
    expect(events).toEqual(["write-succeeded", "delete-issued"]);
    await handle.dispose();
  });

  test("delete cancels pending write so a stale queued write cannot resurrect the record", async () => {
    // Round-2 finding 2: a queued write that was failing/requeueing could be
    // re-applied AFTER delete() succeeded, leaving a ghost HA record.
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((res) => {
      releaseFirstWrite = res;
    });
    const writes: string[] = [];
    let writeAttempt = 0;
    const { transport } = makeTransport(async (method, params) => {
      if (method === "write_batch") {
        writeAttempt++;
        const path = writePath(params);
        if (writeAttempt === 1) {
          await firstWriteGate;
          // First write fails so it would normally requeue.
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "boom", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
          };
        }
        writes.push(path);
        return { ok: true, value: undefined };
      }
      if (method === "delete_batch") return deleteBatchOk(params);
      return { ok: true, value: undefined };
    });
    const handle = createNexusSessionStore({
      transport,
      config: { writeQueue: { flushIntervalMs: 5 } },
    });
    await handle.store.set(session({ id: "ghost" }));
    // delete fires while the failing write is in flight:
    const delP = handle.store.delete("ghost");
    releaseFirstWrite();
    await delP;
    // Give the queue plenty of time to (incorrectly) requeue + retry.
    await new Promise<void>((res) => setTimeout(res, 60));
    // No write must land for the deleted path.
    expect(writes.length).toBe(0);
    await handle.dispose();
  });

  test("degraded probe still cooling down returns EXTERNAL (not NOT_FOUND)", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method !== "read_bulk") return { ok: true, value: undefined };
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "boom", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
      };
    });
    const handle = createNexusSessionStore({
      transport,
      config: {
        degradation: { failureThreshold: 1, probeIntervalMs: 60_000 },
      },
    });
    await handle.store.get("a"); // flip to degraded
    expect(handle.degradation().mode).toBe("degraded");
    const r = await handle.store.get("b");
    expect(r.ok).toBe(false);
    // Distinguish "Nexus unavailable" from "session truly absent".
    if (!r.ok) expect(r.error.code).toBe("EXTERNAL");
    await handle.dispose();
  });
});
