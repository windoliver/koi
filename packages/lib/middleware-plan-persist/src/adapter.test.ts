/**
 * Tests for the plan-persist file backend (adapter.ts).
 *
 * Uses a hand-rolled in-memory `PlanPersistFs` so tests are fully
 * deterministic, no temp dirs, no parallelism races, no flake.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import { createPlanPersistBackend } from "./adapter.js";
import type { PlanPersistFs } from "./config.js";
import type { PlanItem, PlanUpdateContextLike } from "./types.js";

const CWD = "/tmp/koi-plan-persist-test";
const BASE = resolve(CWD, ".koi/plans");

interface MemFsState {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly events: string[];
}

function enoentError(path: string): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
    code?: string;
  };
  err.code = "ENOENT";
  return err;
}

function createMemFs(): { fs: PlanPersistFs; state: MemFsState } {
  const files = new Map<string, string>();
  const dirs = new Set<string>([CWD]);
  const events: string[] = [];

  const fs: PlanPersistFs = {
    mkdir: async (path, _opts): Promise<unknown> => {
      events.push(`mkdir ${path}`);
      // Also add ancestor dirs for the recursive intent.
      let cur = path;
      while (cur && cur !== sep && !dirs.has(cur)) {
        dirs.add(cur);
        cur = cur.slice(0, Math.max(cur.lastIndexOf(sep), 1));
      }
      return undefined;
    },
    writeFile: async (path, data): Promise<void> => {
      events.push(`write ${path}`);
      files.set(path, data);
    },
    readFile: async (path, _enc): Promise<string> => {
      const data = files.get(path);
      if (data === undefined) throw enoentError(path);
      return data;
    },
    rename: async (a, b): Promise<void> => {
      const data = files.get(a);
      if (data === undefined) throw new Error("ENOENT");
      files.delete(a);
      files.set(b, data);
      events.push(`rename ${a} -> ${b}`);
    },
    stat: async (path): Promise<unknown> => {
      if (!files.has(path) && !dirs.has(path)) throw new Error("ENOENT");
      return {};
    },
    realpath: async (path): Promise<string> => {
      if (!files.has(path) && !dirs.has(path)) throw new Error("ENOENT");
      return path;
    },
    unlink: async (path): Promise<void> => {
      if (!files.has(path)) throw enoentError(path);
      files.delete(path);
    },
    link: async (a, b): Promise<void> => {
      const data = files.get(a);
      if (data === undefined) throw new Error("ENOENT");
      if (files.has(b)) {
        const err = new Error("EEXIST") as Error & { code?: string };
        err.code = "EEXIST";
        throw err;
      }
      files.set(b, data);
      events.push(`link ${a} -> ${b}`);
    },
  };

  return { fs, state: { files, dirs, events } };
}

function ctx(sessionId: string, opts: Partial<PlanUpdateContextLike> = {}): PlanUpdateContextLike {
  return {
    sessionId,
    epoch: opts.epoch ?? 1,
    turnIndex: opts.turnIndex ?? 0,
    signal: opts.signal ?? new AbortController().signal,
  };
}

function fixedClock(start: number): () => number {
  let t = start;
  return (): number => t++;
}

function fixedRand(seq: readonly number[]): () => number {
  let i = 0;
  return (): number => {
    const v = seq[i % seq.length] ?? 0;
    i++;
    return v;
  };
}

const SAMPLE_PLAN: readonly PlanItem[] = [
  { content: "Audit auth code", status: "pending" },
  { content: "Design new session model", status: "in_progress" },
  { content: "Migrate sessions", status: "completed" },
];

describe("createPlanPersistBackend — construction", () => {
  test("rejects baseDir outside cwd", () => {
    expect(() =>
      createPlanPersistBackend({ baseDir: "/etc", cwd: CWD, fs: createMemFs().fs }),
    ).toThrow();
  });

  test("rejects baseDir traversal", () => {
    expect(() =>
      createPlanPersistBackend({ baseDir: "../escape", cwd: CWD, fs: createMemFs().fs }),
    ).toThrow();
  });

  test("accepts default baseDir relative to cwd", () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    expect(backend.baseDir).toBe(BASE);
  });
});

describe("onPlanUpdate", () => {
  test("mirrors a successful commit so getActivePlan returns the items", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    expect(backend.getActivePlan("sess-1")).toEqual(SAMPLE_PLAN);
  });

  test("ignores updates whose abort signal already fired (post-teardown stragglers)", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    const ac = new AbortController();
    ac.abort();

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { signal: ac.signal }));
    expect(backend.getActivePlan("sess-1")).toBeUndefined();
  });

  test("dropSession removes the mirror entry but keeps the journal", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    backend.dropSession("sess-1");
    expect(backend.getActivePlan("sess-1")).toBeUndefined();
    // Journal must survive the drop so the next process can recover.
    const journalLeft = [...state.files.keys()].some((k) => k.includes(`/_active/`));
    expect(journalLeft).toBe(true);
  });

  test("replays per-session — sess A and sess B do not bleed", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-A"));
    await backend.onPlanUpdate([{ content: "B item", status: "pending" }], ctx("sess-B"));

    expect(backend.getActivePlan("sess-A")).toEqual(SAMPLE_PLAN);
    expect(backend.getActivePlan("sess-B")).toEqual([{ content: "B item", status: "pending" }]);
  });

  test("writes the active journal so plans survive across processes", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { epoch: 3, turnIndex: 9 }));

    const journalFiles = [...state.files.entries()].filter(([k]) =>
      k.startsWith(`${BASE}/${"_active"}/`),
    );
    expect(journalFiles).toHaveLength(1);
    const [, content] = journalFiles[0] ?? ["", ""];
    expect(content).toContain("- [ ] Audit auth code");
    expect(content).toContain("epoch: 3");
    expect(content).toContain("turnIndex: 9");
  });

  test("journal write failure surfaces to the planning hook caller (no silent loss)", async () => {
    const { fs } = createMemFs();
    const failingFs: PlanPersistFs = {
      ...fs,
      rename: async (_a, _b): Promise<void> => {
        throw new Error("disk full");
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: failingFs });

    await expect(backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"))).rejects.toThrow();
  });

  test("failed journal write does NOT publish the mirror (no split-brain with later savePlan)", async () => {
    const { fs } = createMemFs();
    const failingFs: PlanPersistFs = {
      ...fs,
      rename: async (_a, _b): Promise<void> => {
        throw new Error("disk full");
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: failingFs });

    await expect(backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"))).rejects.toThrow();

    // Mirror MUST be empty — the planning middleware reported the
    // commit as failed, so no later checkpoint is allowed to surface
    // the rejected plan.
    expect(backend.getActivePlan("sess-1")).toBeUndefined();
    const saveResult = await backend.savePlan("sess-1");
    expect(saveResult.ok).toBe(false);
    if (!saveResult.ok) expect(saveResult.error).toBe("no plan to save");
  });
});

describe("savePlan", () => {
  test("returns no-plan-to-save when onPlanUpdate has never fired", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    const result = await backend.savePlan("sess-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no plan to save");
  });

  test("writes a markdown file and returns its absolute path", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 23, 0)),
      rand: fixedRand([0.42]),
    });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { epoch: 2, turnIndex: 5 }));
    const result = await backend.savePlan("sess-1", "auth-refactor");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(BASE, "20260417-102300-auth-refactor.md"));
      const content = state.files.get(result.path) ?? "";
      expect(content).toContain("sessionId: sess-1");
      expect(content).toContain("epoch: 2");
      expect(content).toContain("turnIndex: 5");
      expect(content).toContain("- [ ] Audit auth code");
      expect(content).toContain("- [in_progress] Design new session model");
      expect(content).toContain("- [x] Migrate sessions");
    }
  });

  test("rejects an invalid slug", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));

    const result = await backend.savePlan("sess-1", "../escape");
    expect(result.ok).toBe(false);
  });

  test("auto-generates a slug when none is given", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0, 0]),
    });
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));

    const result = await backend.savePlan("sess-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toMatch(/20260417-100000-[a-z0-9]+(-[a-z0-9]+)+\.md$/);
    }
  });

  test("disambiguates filename collisions with -1 / -2 suffixes via exclusive link", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0.1]),
    });

    state.files.set(join(BASE, "20260417-100000-x.md"), "existing");
    state.files.set(join(BASE, "20260417-100000-x-1.md"), "existing");

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    const result = await backend.savePlan("sess-1", "x");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(BASE, "20260417-100000-x-2.md"));
    }
  });

  test("two concurrent saves with a deterministic PRNG do NOT cross-contaminate (unique tmp paths)", async () => {
    // Fix rand to a single value so every call returns the same
    // pseudo-random suffix — exactly the scenario the temp-counter
    // protects against. Each save still must produce its own correct
    // checkpoint contents.
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: (): number => 0.1,
    });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-A"));
    await backend.onPlanUpdate([{ content: "B item", status: "pending" }], ctx("sess-B"));

    const [a, b] = await Promise.all([
      backend.savePlan("sess-A", "alpha"),
      backend.savePlan("sess-B", "beta"),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      const aContent = state.files.get(a.path) ?? "";
      const bContent = state.files.get(b.path) ?? "";
      expect(aContent).toContain("- [ ] Audit auth code");
      expect(aContent).not.toContain("B item");
      expect(bContent).toContain("- [ ] B item");
      expect(bContent).not.toContain("Audit auth code");
    }
  });

  test("two concurrent saves with the same slug both succeed without overwrite (race-safe link)", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0.1, 0.2]),
    });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-A"));
    await backend.onPlanUpdate([{ content: "B item", status: "pending" }], ctx("sess-B"));

    const [a, b] = await Promise.all([
      backend.savePlan("sess-A", "shared"),
      backend.savePlan("sess-B", "shared"),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.path).not.toBe(b.path);
      // Both files must remain on disk — no silent clobber.
      expect(state.files.has(a.path)).toBe(true);
      expect(state.files.has(b.path)).toBe(true);
    }
  });

  test("link failure leaves no orphan tmp files and surfaces the error", async () => {
    const { fs, state } = createMemFs();
    const failingFs: PlanPersistFs = {
      ...fs,
      link: async (_a, _b): Promise<void> => {
        throw new Error("simulated link failure");
      },
    };
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs: failingFs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0.5]),
    });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    await expect(backend.savePlan("sess-1", "x")).rejects.toThrow();

    expect(state.files.has(join(BASE, "20260417-100000-x.md"))).toBe(false);
    const tempLeftovers = [...state.files.keys()].filter((k) => k.includes(`${BASE}/.tmp.`));
    expect(tempLeftovers).toEqual([]);
  });
});

describe("restoreFromJournal", () => {
  test("returns not-found when no journal exists for the session", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    const result = await backend.restoreFromJournal("never-seen");
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  test("recovers the latest plan after a simulated process restart", async () => {
    const { fs, state } = createMemFs();
    const backend1 = createPlanPersistBackend({ cwd: CWD, fs });
    await backend1.onPlanUpdate(SAMPLE_PLAN, ctx("sess-restart", { epoch: 4, turnIndex: 11 }));

    // Simulate restart: brand-new backend instance, same fs state, same sessionId.
    const backend2 = createPlanPersistBackend({ cwd: CWD, fs });
    expect(backend2.getActivePlan("sess-restart")).toBeUndefined();

    const restored = await backend2.restoreFromJournal("sess-restart");
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.items).toEqual(SAMPLE_PLAN);
    }
    expect(backend2.getActivePlan("sess-restart")).toEqual(SAMPLE_PLAN);

    // Sanity: the journal is still on disk (not consumed by restore).
    const journalFiles = [...state.files.keys()].filter((k) => k.includes(`/_active/`));
    expect(journalFiles).toHaveLength(1);
  });

  test("returns corrupt (with details) when the journal file is malformed", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-corrupt"));
    const journalKey = [...state.files.keys()].find((k) => k.includes(`/_active/`));
    expect(journalKey).toBeDefined();
    if (journalKey === undefined) return;
    state.files.set(journalKey, "not a valid plan markdown\n");

    const fresh = createPlanPersistBackend({ cwd: CWD, fs });
    const result = await fresh.restoreFromJournal("sess-corrupt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("corrupt");
      if (result.reason === "corrupt") {
        expect(result.details.length).toBeGreaterThan(0);
      }
    }
  });

  test("returns io-error (not not-found) for non-ENOENT read failures", async () => {
    const { fs } = createMemFs();
    const ioFs: PlanPersistFs = {
      ...fs,
      readFile: async (_p, _e): Promise<string> => {
        const err = new Error("EACCES: permission denied") as Error & { code?: string };
        err.code = "EACCES";
        throw err;
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: ioFs });
    const result = await backend.restoreFromJournal("sess-locked");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("io-error");
      if (result.reason === "io-error") {
        const cause = result.cause as { code?: string };
        expect(cause.code).toBe("EACCES");
      }
    }
  });
});

describe("clearJournal — serialized with the per-session write chain", () => {
  test("a queued onPlanUpdate that races clearJournal cannot recreate the journal after clear", async () => {
    const { fs, state } = createMemFs();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Slow down the journal write (the rename step) so we have a real
    // window where an in-flight onPlanUpdate is queued while
    // clearJournal is invoked.
    const slowFs: PlanPersistFs = {
      ...fs,
      rename: async (a, b): Promise<void> => {
        await gate;
        await fs.rename(a, b);
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: slowFs });

    // Kick off a write but don't await — it parks at the rename gate.
    const writePromise = backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-cj"));
    // Clear is queued behind the in-flight write.
    const clearPromise = backend.clearJournal("sess-cj");
    // Release the rename so the write can finish, then clear runs.
    if (!release) throw new Error("gate not initialized");
    release();
    await writePromise;
    const clearResult = await clearPromise;

    expect(clearResult.ok).toBe(true);
    const journalLeft = [...state.files.keys()].some((k) => k.includes(`/_active/`));
    expect(journalLeft).toBe(false);
  });

  test("a write that arrives DURING clearJournal's unlink waits behind the chain — no journal recreation", async () => {
    const { fs, state } = createMemFs();
    let releaseUnlink: (() => void) | undefined;
    const unlinkGate = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    const slowFs: PlanPersistFs = {
      ...fs,
      unlink: async (p): Promise<void> => {
        await unlinkGate;
        await fs.unlink(p);
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: slowFs });

    // Seed a plan so the journal exists.
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-race-clear"));

    // Start clear (parks at the slow unlink). Don't await yet.
    const clearPromise = backend.clearJournal("sess-race-clear");
    // While clear is parked, fire a new write. The chain MUST keep it
    // queued behind the clear so the new write cannot recreate the
    // journal between the in-memory delete and the unlink.
    const racingWrite = backend.onPlanUpdate(
      [{ content: "racing", status: "pending" }],
      ctx("sess-race-clear", { epoch: 9 }),
    );

    // Release the unlink. Clear completes, then the racing write runs.
    if (!releaseUnlink) throw new Error("gate not initialized");
    releaseUnlink();

    const clearResult = await clearPromise;
    await racingWrite;

    expect(clearResult.ok).toBe(true);
    // The racing write IS allowed to write its own journal AFTER the
    // clear (that's a legitimate new write, not a stale one). The
    // critical property is that the clear's unlink was NOT raced — the
    // journal contents must reflect the racing write, not the
    // pre-clear plan.
    const journalKey = [...state.files.keys()].find((k) => k.includes(`/_active/`));
    expect(journalKey).toBeDefined();
    if (journalKey === undefined) return;
    const content = state.files.get(journalKey) ?? "";
    expect(content).toContain("racing");
    expect(content).not.toContain("Audit auth code");
  });

  test("clearJournal also drops the in-memory mirror so getActivePlan + savePlan cannot leak the cleared plan", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-leak"));
    expect(backend.getActivePlan("sess-leak")).toEqual(SAMPLE_PLAN);

    const cleared = await backend.clearJournal("sess-leak");
    expect(cleared.ok).toBe(true);

    // Mirror MUST be empty — the host expects /clear to wipe state, not
    // just the on-disk journal.
    expect(backend.getActivePlan("sess-leak")).toBeUndefined();
    const save = await backend.savePlan("sess-leak");
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error).toBe("no plan to save");
  });

  test("clearJournal is silent on a missing journal", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    const result = await backend.clearJournal("never-existed");
    expect(result).toEqual({ ok: true });
  });

  test("dropSession cleans up per-session epoch + chain so recycled IDs are not constrained by old ceiling", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    // Old incarnation reaches epoch 5.
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-recycle", { epoch: 5 }));
    backend.dropSession("sess-recycle");

    // New incarnation under the SAME sessionId starts at epoch 1
    // (which simulates a process where planning's per-MW epoch counter
    // was reset). Without dropSession clearing the ceiling, this write
    // would be incorrectly rejected because 1 < old-ceiling (5) and
    // the mirror would never be updated.
    await backend.onPlanUpdate(
      [{ content: "fresh", status: "pending" }],
      ctx("sess-recycle", { epoch: 1 }),
    );
    expect(backend.getActivePlan("sess-recycle")).toEqual([
      { content: "fresh", status: "pending" },
    ]);
  });

  test("clearJournal surfaces non-ENOENT errors", async () => {
    const { fs } = createMemFs();
    const failingFs: PlanPersistFs = {
      ...fs,
      unlink: async (_p): Promise<void> => {
        const err = new Error("EACCES") as Error & { code?: string };
        err.code = "EACCES";
        throw err;
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: failingFs });
    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-locked"));
    const result = await backend.clearJournal("sess-locked");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("io-error");
    }
  });
});

describe("onPlanUpdate — epoch CAS + per-session ordering", () => {
  test("drops a strictly older-epoch write so it cannot overwrite a newer journal", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    // Newer epoch arrives first and lands.
    await backend.onPlanUpdate(
      [{ content: "newer", status: "in_progress" }],
      ctx("sess-cas", { epoch: 5, turnIndex: 0 }),
    );
    const journalKey = [...state.files.keys()].find((k) => k.includes(`/_active/`));
    expect(journalKey).toBeDefined();
    if (journalKey === undefined) return;
    const newerContent = state.files.get(journalKey) ?? "";

    // Stale-epoch hook arrives later (e.g. an in-flight write from the
    // prior session incarnation that finished after teardown). It MUST
    // be rejected; the journal must still hold the newer plan.
    await backend.onPlanUpdate(
      [{ content: "stale", status: "pending" }],
      ctx("sess-cas", { epoch: 4, turnIndex: 99 }),
    );
    expect(state.files.get(journalKey)).toBe(newerContent);
    expect(backend.getActivePlan("sess-cas")).toEqual([
      { content: "newer", status: "in_progress" },
    ]);
  });

  test("an abort fired between writeFile and rename does NOT commit the journal", async () => {
    const { fs, state } = createMemFs();
    // Trigger the abort right after the temp writeFile so the rename
    // window is open. We hook writeFile so the abort fires precisely
    // mid-commit.
    const ac = new AbortController();
    const racingFs: PlanPersistFs = {
      ...fs,
      writeFile: async (path, data): Promise<void> => {
        await fs.writeFile(path, data);
        ac.abort();
      },
    };
    const backend = createPlanPersistBackend({ cwd: CWD, fs: racingFs });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-aborted", { signal: ac.signal }));

    const journalKey = [...state.files.keys()].find((k) => k.includes(`/_active/`));
    expect(journalKey).toBeUndefined(); // rename was skipped
    const tmpLeft = [...state.files.keys()].some((k) => k.includes(".tmp."));
    expect(tmpLeft).toBe(false); // temp cleaned up
    expect(backend.getActivePlan("sess-aborted")).toBeUndefined();
  });

  test("serializes concurrent same-session writes so the highest-epoch snapshot wins on disk", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    // Fire both concurrently. Per-session chain + epoch CAS together
    // guarantee the higher-epoch plan ends up in the journal.
    const slow = backend.onPlanUpdate(
      [{ content: "old", status: "pending" }],
      ctx("sess-race", { epoch: 1, turnIndex: 0 }),
    );
    const fast = backend.onPlanUpdate(
      [{ content: "new", status: "pending" }],
      ctx("sess-race", { epoch: 2, turnIndex: 0 }),
    );
    await Promise.all([slow, fast]);

    expect(backend.getActivePlan("sess-race")).toEqual([{ content: "new", status: "pending" }]);
    const journalKey = [...state.files.keys()].find((k) => k.includes(`/_active/`));
    expect(journalKey).toBeDefined();
    if (journalKey === undefined) return;
    expect(state.files.get(journalKey)).toContain("- [ ] new");
  });
});

describe("loadPlan", () => {
  test("round-trips a saved plan to identical items", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0.5]),
    });

    await backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { epoch: 1, turnIndex: 0 }));
    const saved = await backend.savePlan("sess-1", "round-trip");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const loaded = await backend.loadPlan(saved.path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.items).toEqual(SAMPLE_PLAN);
    }
  });

  test("rejects path traversal", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    const result = await backend.loadPlan("/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("path outside baseDir");
  });

  test("returns file-not-found for a missing plan", async () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    const result = await backend.loadPlan(join(BASE, "missing.md"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("file not found");
  });

  test("returns invalid-format for a malformed file", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    const path = join(BASE, "broken.md");
    state.files.set(path, "not a valid plan markdown\nrandom text\n");

    const result = await backend.loadPlan(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid plan format");
  });
});
