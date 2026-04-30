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
