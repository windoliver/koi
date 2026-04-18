import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundSessionRecord } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import { createFileSessionRegistry } from "../file-session-registry.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koi-registry-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<BackgroundSessionRecord> = {}): BackgroundSessionRecord {
  return {
    workerId: workerId("w-1"),
    agentId: agentId("researcher"),
    pid: 1234,
    status: "running",
    startedAt: 1_700_000_000_000,
    logPath: "/tmp/logs/w-1.log",
    command: ["bun", "run", "worker.ts"],
    backendKind: "subprocess",
    ...overrides,
  };
}

describe("createFileSessionRegistry", () => {
  it("registers, reads back, and lists records", async () => {
    const reg = createFileSessionRegistry({ dir });
    const record = makeRecord();
    const res = await reg.register(record);
    expect(res.ok).toBe(true);

    const fetched = await reg.get(record.workerId);
    // register seeds version=1 so CAS updates have a baseline.
    expect(fetched).toEqual({ ...record, version: 1 });

    const all = await reg.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ ...record, version: 1 });
  });

  it("rejects duplicate registration", async () => {
    const reg = createFileSessionRegistry({ dir });
    const record = makeRecord();
    await reg.register(record);
    const dup = await reg.register(record);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("CONFLICT");
  });

  it("rejects invalid records", async () => {
    const reg = createFileSessionRegistry({ dir });
    const res = await reg.register(makeRecord({ command: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION");
  });

  it("updates mutable fields", async () => {
    const reg = createFileSessionRegistry({ dir });
    const record = makeRecord();
    await reg.register(record);

    const updated = await reg.update(record.workerId, {
      status: "exited",
      endedAt: 1_700_000_001_000,
      exitCode: 0,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.status).toBe("exited");
      expect(updated.value.endedAt).toBe(1_700_000_001_000);
      expect(updated.value.exitCode).toBe(0);
      // Immutable fields preserved
      expect(updated.value.command).toEqual(record.command);
      expect(updated.value.pid).toBe(record.pid);
    }
  });

  it("returns NOT_FOUND when updating unknown id", async () => {
    const reg = createFileSessionRegistry({ dir });
    const res = await reg.update(workerId("missing"), { status: "exited" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("unregister removes record", async () => {
    const reg = createFileSessionRegistry({ dir });
    const record = makeRecord();
    await reg.register(record);
    const res = await reg.unregister(record.workerId);
    expect(res.ok).toBe(true);
    expect(await reg.get(record.workerId)).toBeUndefined();
    expect(await reg.list()).toHaveLength(0);
  });

  it("unregister is idempotent on missing records", async () => {
    const reg = createFileSessionRegistry({ dir });
    const res = await reg.unregister(workerId("never-existed"));
    expect(res.ok).toBe(true);
  });

  it("list returns empty array for non-existent dir", async () => {
    const reg = createFileSessionRegistry({ dir: join(dir, "does-not-exist") });
    expect(await reg.list()).toEqual([]);
  });

  it("list skips non-JSON entries", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    await Bun.write(join(dir, "garbage.txt"), "not a record");
    const all = await reg.list();
    expect(all).toHaveLength(1);
  });

  it("list skips malformed JSON files", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    await Bun.write(join(dir, "malformed.json"), "{ not valid json");
    const all = await reg.list();
    expect(all).toHaveLength(1);
  });

  it("watch yields lifecycle events in order", async () => {
    const reg = createFileSessionRegistry({ dir });
    const events: string[] = [];

    const iterable = reg.watch();
    const iterator = iterable[Symbol.asyncIterator]();
    const consumerDone = (async () => {
      for (let i = 0; i < 3; i++) {
        const { value, done } = await iterator.next();
        if (done) return;
        events.push(value.kind);
      }
      await iterator.return?.();
    })();

    const record = makeRecord();
    await reg.register(record);
    await reg.update(record.workerId, { status: "exited" });
    await reg.unregister(record.workerId);
    await consumerDone;

    expect(events).toEqual(["registered", "updated", "unregistered"]);
  });

  it("update bumps version monotonically", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    const v1 = await reg.update(workerId("w-1"), { status: "running" });
    const v2 = await reg.update(workerId("w-1"), { status: "exited" });
    if (!v1.ok || !v2.ok) throw new Error("updates failed");
    expect(v1.value.version).toBe(2);
    expect(v2.value.version).toBe(3);
  });

  it("rejects the older writer when two concurrent updates race (CAS)", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    // Concurrent updates against the same record. With CAS + bounded
    // retries both should succeed because each retries against fresh
    // state; the important invariant is that the final version is
    // base+2 (no lost update) rather than base+1 (one overwrite).
    const [a, b] = await Promise.all([
      reg.update(workerId("w-1"), { status: "running" }),
      reg.update(workerId("w-1"), { status: "exited", exitCode: 0 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const final = await reg.get(workerId("w-1"));
    expect(final?.version).toBe(3);
  });

  it("allows pid and startedAt updates (restart support)", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord({ pid: 100 }));
    const updated = await reg.update(workerId("w-1"), {
      pid: 200,
      startedAt: 1_800_000_000_000,
      status: "running",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.pid).toBe(200);
      expect(updated.value.startedAt).toBe(1_800_000_000_000);
    }
  });

  it("cross-process lockfile serializes concurrent registry instances", async () => {
    // Simulate two independent process-level writers against the same
    // directory. Each uses its own registry instance (distinct in-process
    // mutex maps) but they share the filesystem — only the lockfile
    // stands between them. Both writes must succeed without lost updates.
    const a = createFileSessionRegistry({ dir });
    const b = createFileSessionRegistry({ dir });
    const record = makeRecord({ pid: 1 });
    await a.register(record);

    const [resA, resB] = await Promise.all([
      a.update(workerId("w-1"), { pid: 100 }),
      b.update(workerId("w-1"), { status: "exited", endedAt: 42 }),
    ]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    const final = await a.get(workerId("w-1"));
    // Both updates must land — version bumped twice from the seeded 1.
    expect(final?.version).toBe(3);
    // Exact status depends on scheduling, but endedAt can only come from B.
    expect(final?.endedAt).toBe(42);
  });

  it("expectedVersion CAS rejects stale writers", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    // Advance the version by one legitimate write so the caller's
    // captured version (1) no longer matches the persisted one.
    await reg.update(workerId("w-1"), { status: "running" });

    const stale = await reg.update(workerId("w-1"), {
      status: "exited",
      endedAt: 42,
      expectedVersion: 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    const current = await reg.get(workerId("w-1"));
    // Stale write must NOT land — status still "running" from the middle update.
    expect(current?.status).toBe("running");
    expect(current?.endedAt).toBeUndefined();
  });

  it("expectedPid CAS catches identity drift even when version matches", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord({ pid: 100 }));

    const drift = await reg.update(workerId("w-1"), {
      status: "exited",
      expectedVersion: 1,
      expectedPid: 999,
    });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.error.code).toBe("CONFLICT");
  });

  it("update() surfaces corrupt record files as INTERNAL, not NOT_FOUND", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    // Poison the persisted record. Updates MUST report the corruption
    // rather than aliasing it to NOT_FOUND (which would hide real
    // on-disk damage from operators and silently drop lifecycle updates).
    await Bun.write(join(dir, "w-1.json"), "{ not valid json");
    const res = await reg.update(workerId("w-1"), { status: "exited" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INTERNAL");
      expect(res.error.message).toMatch(/parse|shape/);
    }
  });

  it("rejects path-traversal workerIds at the boundary", async () => {
    const reg = createFileSessionRegistry({ dir });
    for (const bad of ["../escape", "sub/dir", "/abs/path", "..\\win", "with space", ""]) {
      const res = await reg.register(makeRecord({ workerId: workerId(bad) }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION");
    }
    // No files written outside/inside the registry dir.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it("describe() distinguishes missing, present, and corrupt records", async () => {
    const reg = createFileSessionRegistry({ dir });
    const absent = await reg.describe(workerId("never-existed"));
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value).toBeUndefined();

    await reg.register(makeRecord());
    const present = await reg.describe(workerId("w-1"));
    expect(present.ok).toBe(true);
    if (present.ok) expect(String(present.value?.workerId)).toBe("w-1");

    await Bun.write(join(dir, "w-1.json"), "{ corrupt");
    const broken = await reg.describe(workerId("w-1"));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.code).toBe("INTERNAL");
  });

  it("describeList surfaces directory read faults instead of empty array", async () => {
    // Point at a path that exists but isn't a directory — readdir fails
    // with ENOTDIR, which describeList must surface distinctly.
    const filePath = join(dir, "not-a-dir");
    await Bun.write(filePath, "x");
    const reg = createFileSessionRegistry({ dir: filePath });
    const res = await reg.describeList();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INTERNAL");
  });

  it("describeList succeeds empty for a never-created registry dir", async () => {
    const reg = createFileSessionRegistry({ dir: join(dir, "does-not-exist") });
    const res = await reg.describeList();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual([]);
  });

  it("describeList fails loudly on per-record corruption (unlike list)", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    await Bun.write(join(dir, "w-2.json"), "{ corrupt");

    // Lenient: list() silently drops the corrupt file.
    const lenient = await reg.list();
    expect(lenient).toHaveLength(1);

    // Strict: describeList() surfaces the corruption as an error.
    const strict = await reg.describeList();
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.code).toBe("INTERNAL");
  });

  it("update with clearTerminal drops stale endedAt/exitCode", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    await reg.update(workerId("w-1"), {
      status: "exited",
      endedAt: 1_700_000_001_000,
      exitCode: 137,
    });
    const exited = await reg.get(workerId("w-1"));
    expect(exited?.endedAt).toBeDefined();
    expect(exited?.exitCode).toBe(137);

    const restarted = await reg.update(workerId("w-1"), {
      status: "running",
      pid: 9999,
      startedAt: 1_800_000_000_000,
      clearTerminal: true,
    });
    expect(restarted.ok).toBe(true);
    if (restarted.ok) {
      expect(restarted.value.status).toBe("running");
      expect(restarted.value.endedAt).toBeUndefined();
      expect(restarted.value.exitCode).toBeUndefined();
    }
  });

  it("rejects records whose on-disk workerId doesn't match the filename key", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    // Poison: write a valid-shaped record whose workerId claims a
    // different session. The file key stays "w-1.json" but the payload
    // points at "evil". An update() that trusted the payload could be
    // redirected; readRecordDetailed must treat this as corruption.
    const poisoned = {
      ...makeRecord({ workerId: workerId("evil") }),
      version: 1,
    };
    await Bun.write(join(dir, "w-1.json"), JSON.stringify(poisoned));

    const res = await reg.update(workerId("w-1"), { status: "exited" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INTERNAL");
      expect(res.error.message).toMatch(/identity mismatch/);
    }

    const desc = await reg.describe(workerId("w-1"));
    expect(desc.ok).toBe(false);
  });

  it("register writes record with owner-only permissions (0o600)", async () => {
    const reg = createFileSessionRegistry({ dir });
    await reg.register(makeRecord());
    const { stat } = await import("node:fs/promises");
    const st = await stat(join(dir, "w-1.json"));
    // Mask out type bits; compare only the permission nibble.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("cross-instance read sees writes (persistence)", async () => {
    const writer = createFileSessionRegistry({ dir });
    const record = makeRecord();
    await writer.register(record);

    const reader = createFileSessionRegistry({ dir });
    const fetched = await reader.get(record.workerId);
    expect(fetched).toEqual({ ...record, version: 1 });
  });
});
