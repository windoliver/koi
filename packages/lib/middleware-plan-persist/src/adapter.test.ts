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
      if (data === undefined) throw new Error("ENOENT");
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
      if (!files.has(path)) throw new Error("ENOENT");
      files.delete(path);
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
  test("mirrors a successful commit so getActivePlan returns the items", () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    expect(backend.getActivePlan("sess-1")).toEqual(SAMPLE_PLAN);
  });

  test("ignores updates whose abort signal already fired (post-teardown stragglers)", () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    const ac = new AbortController();
    ac.abort();

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { signal: ac.signal }));
    expect(backend.getActivePlan("sess-1")).toBeUndefined();
  });

  test("dropSession removes the mirror entry", () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    backend.dropSession("sess-1");
    expect(backend.getActivePlan("sess-1")).toBeUndefined();
  });

  test("replays per-session — sess A and sess B do not bleed", () => {
    const { fs } = createMemFs();
    const backend = createPlanPersistBackend({ cwd: CWD, fs });
    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-A"));
    backend.onPlanUpdate([{ content: "B item", status: "pending" }], ctx("sess-B"));

    expect(backend.getActivePlan("sess-A")).toEqual(SAMPLE_PLAN);
    expect(backend.getActivePlan("sess-B")).toEqual([{ content: "B item", status: "pending" }]);
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

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { epoch: 2, turnIndex: 5 }));
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
    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));

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
    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));

    const result = await backend.savePlan("sess-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toMatch(/20260417-100000-[a-z0-9]+(-[a-z0-9]+)+\.md$/);
    }
  });

  test("disambiguates filename collisions with -1 / -2 suffixes", async () => {
    const { fs, state } = createMemFs();
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0.1]),
    });

    state.files.set(join(BASE, "20260417-100000-x.md"), "existing");
    state.files.set(join(BASE, "20260417-100000-x-1.md"), "existing");

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    const result = await backend.savePlan("sess-1", "x");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(BASE, "20260417-100000-x-2.md"));
    }
  });

  test("uses temp+rename for atomic writes (no partial files on rename failure)", async () => {
    const { fs, state } = createMemFs();
    const failingFs: PlanPersistFs = {
      ...fs,
      rename: async (_a, _b): Promise<void> => {
        throw new Error("simulated rename failure");
      },
    };
    const backend = createPlanPersistBackend({
      cwd: CWD,
      fs: failingFs,
      now: fixedClock(Date.UTC(2026, 3, 17, 10, 0, 0)),
      rand: fixedRand([0.5]),
    });

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1"));
    await expect(backend.savePlan("sess-1", "x")).rejects.toThrow();

    // Final file must NOT exist.
    expect(state.files.has(join(BASE, "20260417-100000-x.md"))).toBe(false);
    // Temp file must have been cleaned up by best-effort unlink.
    const tempLeftovers = [...state.files.keys()].filter((k) => k.includes(".tmp."));
    expect(tempLeftovers).toEqual([]);
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

    backend.onPlanUpdate(SAMPLE_PLAN, ctx("sess-1", { epoch: 1, turnIndex: 0 }));
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
