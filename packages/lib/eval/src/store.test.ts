import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

  test("ids that differ only by reserved chars do not collide", async () => {
    const store = createFsStore(root);
    await store.save(makeRun("a/b", "smoke", "2026-01-01T00:00:00Z"));
    await store.save(makeRun("a_b", "smoke", "2026-02-01T00:00:00Z"));
    const a1 = await store.load("a/b");
    const a2 = await store.load("a_b");
    expect(a1?.id).toBe("a/b");
    expect(a2?.id).toBe("a_b");
  });

  test("list returns empty for unknown eval", async () => {
    const store = createFsStore(root);
    expect(await store.list("missing")).toHaveLength(0);
  });
});
