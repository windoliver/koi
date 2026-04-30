import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore } from "./store.js";
import type { EvalRun } from "./types.js";

const makeRun = (id: string, name: string, timestamp: string): EvalRun => ({
  id,
  name,
  timestamp,
  config: { name, timeoutMs: 60_000, passThreshold: 0.5, taskCount: 1 },
  trials: [],
  summary: {
    taskCount: 1,
    trialCount: 0,
    passRate: 1,
    meanScore: 1,
    errorCount: 0,
    byTask: [],
  },
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "koi-eval-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createFsStore", () => {
  test("save then load round-trips a run", async () => {
    const store = createFsStore(root);
    const run = makeRun("r1", "smoke", "2026-01-01T00:00:00Z");
    await store.save(run);
    const loaded = await store.load("r1");
    expect(loaded?.id).toBe("r1");
    expect(loaded?.name).toBe("smoke");
  });

  test("load returns undefined for unknown id", async () => {
    const store = createFsStore(root);
    expect(await store.load("nope")).toBeUndefined();
  });

  test("latest returns most recent by timestamp", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("r1", "smoke", "2026-01-01T00:00:00Z"));
    await store.save(makeRun("r2", "smoke", "2026-02-01T00:00:00Z"));
    const latest = await store.latest("smoke");
    expect(latest?.id).toBe("r2");
  });

  test("list returns metas sorted desc", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("a", "smoke", "2026-01-01T00:00:00Z"));
    await store.save(makeRun("b", "smoke", "2026-03-01T00:00:00Z"));
    const metas = await store.list("smoke");
    expect(metas).toHaveLength(2);
    expect(metas[0]?.id).toBe("b");
  });

  test("load with same runId across suites returns undefined unless evalName given", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("shared", "suite-a", "2026-01-01T00:00:00Z"));
    await store.save(makeRun("shared", "suite-b", "2026-02-01T00:00:00Z"));
    expect(await store.load("shared")).toBeUndefined();
    const a = await store.load("shared", "suite-a");
    const b = await store.load("shared", "suite-b");
    expect(a?.name).toBe("suite-a");
    expect(b?.name).toBe("suite-b");
  });

  test("ids that differ only by reserved chars do not collide", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("a/b", "smoke", "2026-01-01T00:00:00Z"));
    await store.save(makeRun("a_b", "smoke", "2026-02-01T00:00:00Z"));
    const a1 = await store.load("a/b");
    const a2 = await store.load("a_b");
    expect(a1?.id).toBe("a/b");
    expect(a2?.id).toBe("a_b");
  });

  test("latest skips a stale corrupt artifact when a newer valid one exists", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("good", "smoke", "2026-02-01T00:00:00Z"));
    // Inject an older corrupt file (smaller mtime by waiting + writing later
    // would be wrong direction; we want the corrupt file to be older). Set
    // mtime backward via utimes.
    const dir = join(root, encodeURIComponent("smoke"));
    const badPath = join(dir, "bad-old.json");
    await writeFile(badPath, "{ corrupt", "utf8");
    const past = new Date(2025, 0, 1);
    await (await import("node:fs/promises")).utimes(badPath, past, past);
    const latest = await store.latest("smoke");
    expect(latest?.id).toBe("good");
  });

  test("latest fails closed when the newest file is corrupt", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("good", "smoke", "2026-01-01T00:00:00Z"));
    // Newer file (now) that is corrupt
    const dir = join(root, encodeURIComponent("smoke"));
    await writeFile(join(dir, "newer-bad.json"), "{ corrupt", "utf8");
    await expect(store.latest("smoke")).rejects.toThrow(/corrupt/);
  });

  test("load rejects suite/name mismatch when scoped by evalName", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("r1", "right-suite", "2026-01-01T00:00:00Z"));
    // Misplaced: physically copy the file under wrong-suite
    const wrongDir = join(root, encodeURIComponent("wrong-suite"));
    await (await import("node:fs/promises")).mkdir(wrongDir, { recursive: true });
    const src = join(root, encodeURIComponent("right-suite"), `${encodeURIComponent("r1")}.json`);
    const dst = join(wrongDir, `${encodeURIComponent("r1")}.json`);
    await writeFile(dst, await (await import("node:fs/promises")).readFile(src, "utf8"));
    await expect(store.load("r1", "wrong-suite")).rejects.toThrow(/mismatch/);
  });

  test("load rejects parseable JSON with malformed trials", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("seed", "smoke", "2026-01-01T00:00:00Z"));
    const dir = join(root, encodeURIComponent("smoke"));
    const malformed = JSON.stringify({
      id: "bad-trials",
      name: "smoke",
      timestamp: "2026-01-02T00:00:00Z",
      config: { name: "smoke", timeoutMs: 60000, passThreshold: 0.5, taskCount: 1 },
      trials: [{ taskId: 42 }], // wrong type
      summary: {
        taskCount: 1,
        trialCount: 1,
        passRate: 1,
        meanScore: 1,
        errorCount: 0,
        byTask: [],
      },
    });
    await writeFile(join(dir, `${encodeURIComponent("bad-trials")}.json`), malformed, "utf8");
    await expect(store.load("bad-trials", "smoke")).rejects.toThrow(/corrupt/);
  });

  test("load rejects parseable JSON that is missing required fields", async () => {
    const store = createFsStore(root);
    const dir = join(root, encodeURIComponent("smoke"));
    await store.save(makeRun("seed", "smoke", "2026-01-01T00:00:00Z"));
    // Valid JSON but missing config/trials/summary fields
    const malformed = JSON.stringify({
      id: "shallow",
      name: "smoke",
      timestamp: "2026-01-02T00:00:00Z",
      summary: { passRate: 1 },
    });
    await writeFile(join(dir, `${encodeURIComponent("shallow")}.json`), malformed, "utf8");
    await expect(store.load("shallow", "smoke")).rejects.toThrow(/corrupt/);
  });

  test("load throws on corrupted run file (fail-closed for regression gate)", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("bad", "smoke", "2026-01-01T00:00:00Z"));
    const dir = join(root, encodeURIComponent("smoke"));
    await writeFile(join(dir, `${encodeURIComponent("bad")}.json`), "{ corrupt", "utf8");
    await expect(store.load("bad", "smoke")).rejects.toThrow(/corrupt/);
  });

  test("malformed sibling file does not break list, but blocks latest (fail-closed)", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("good", "smoke", "2026-02-01T00:00:00Z"));
    const dir = join(root, encodeURIComponent("smoke"));
    await writeFile(join(dir, "bad.json"), "{ this is not json", "utf8");
    const metas = await store.list("smoke");
    expect(metas).toHaveLength(1);
    expect(metas[0]?.id).toBe("good");
    await expect(store.latest("smoke")).rejects.toThrow(/corrupted/);
  });

  test("list returns empty for unknown eval", async () => {
    const store = createFsStore(root);
    expect(await store.list("missing")).toHaveLength(0);
  });
});
