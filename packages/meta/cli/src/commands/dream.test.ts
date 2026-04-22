/**
 * Tests for `koi dream` command.
 *
 * Uses dependency injection (DreamDeps override) instead of mock.module()
 * because Bun's mock.module is process-global and would leak fake
 * @koi/memory-fs / @koi/model-openai-compat across test files in the same
 * package, breaking unrelated tests like memory-adapter.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../types.js";
import type { DreamDeps } from "./dream.js";
import { run } from "./dream.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;
let savedOpenRouter: string | undefined;
let savedOpenAI: string | undefined;

beforeEach(async () => {
  testDir = join(tmpdir(), `dream-test-${String(Date.now())}-${String(Math.random()).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  savedOpenRouter = process.env.OPENROUTER_API_KEY;
  savedOpenAI = process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (savedOpenRouter !== undefined) {
    process.env.OPENROUTER_API_KEY = savedOpenRouter;
  } else {
    delete process.env.OPENROUTER_API_KEY;
  }
  if (savedOpenAI !== undefined) {
    process.env.OPENAI_API_KEY = savedOpenAI;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// Default fake DreamDeps used by most tests
// ---------------------------------------------------------------------------

interface DepsOverrides {
  readonly shouldDream?: boolean;
  readonly consolidationResult?: {
    merged: number;
    pruned: number;
    unchanged: number;
    durationMs: number;
  };
}

function makeDeps(overrides: DepsOverrides = {}): DreamDeps {
  const consolidationResult = overrides.consolidationResult ?? {
    merged: 0,
    pruned: 0,
    unchanged: 0,
    durationMs: 0,
  };
  return {
    shouldDream: () => overrides.shouldDream ?? true,
    runDreamConsolidation: async () => consolidationResult,
    createMemoryStore: () =>
      ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }) as unknown as ReturnType<typeof import("@koi/memory-fs").createMemoryStore>,
    createOpenAICompatAdapter: () =>
      ({
        complete: async () => ({ content: "", model: "test" }),
      }) as unknown as ReturnType<
        typeof import("@koi/model-openai-compat").createOpenAICompatAdapter
      >,
  };
}

// ---------------------------------------------------------------------------
// Unit test: isDreamFlags (light smoke)
// ---------------------------------------------------------------------------

describe("dream args (smoke)", () => {
  it("isDreamFlags accepts dream command", async () => {
    const { isDreamFlags } = await import("../args/dream.js");
    expect(isDreamFlags({ command: "dream", version: false, help: false })).toBe(true);
  });

  it("isDreamFlags rejects non-dream command", async () => {
    const { isDreamFlags } = await import("../args/dream.js");
    expect(isDreamFlags({ command: "doctor", version: false, help: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command: run() with real filesystem + injected deps
// ---------------------------------------------------------------------------

type DreamRunFlags = {
  command: "dream";
  version: boolean;
  help: boolean;
  memoryDir: string | undefined;
  model: string | undefined;
  modelUrl: string | undefined;
  force: boolean;
  json: boolean;
};

function makeDreamFlags(overrides?: Partial<DreamRunFlags>): DreamRunFlags {
  return {
    command: "dream",
    version: false,
    help: false,
    memoryDir: testDir,
    model: undefined,
    modelUrl: undefined,
    force: false,
    json: false,
    ...overrides,
  };
}

describe("run()", () => {
  it("returns FAILURE when flags are wrong type", async () => {
    const result = await run({ command: "doctor", version: false, help: false });
    expect(result).toBe(ExitCode.FAILURE);
  });

  it("returns FAILURE when no API key available", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const stderrChunks: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const result = await run(makeDreamFlags(), makeDeps());

    spy.mockRestore();
    expect(result).toBe(ExitCode.FAILURE);
    expect(stderrChunks.join("")).toContain("no API key");
  });

  it("error message no longer references removed --api-key flag", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const stderrChunks: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    await run(makeDreamFlags(), makeDeps());
    spy.mockRestore();
    const out = stderrChunks.join("");
    expect(out).not.toContain("--api-key");
    expect(out).toContain("environment variable");
  });

  it("OPENAI_API_KEY works when OPENROUTER_API_KEY is unset", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(makeDreamFlags({ force: true }), makeDeps());
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream complete");
  });

  it("gate skip: prints message and returns OK when gate not triggered", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    const gateState = { lastDreamAt: Date.now(), sessionsSinceDream: 0 };
    await writeFile(join(testDir, ".dream-gate.json"), JSON.stringify(gateState));

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(makeDreamFlags({ force: false }), makeDeps({ shouldDream: false }));
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream gate not triggered");
  });

  it("--force bypasses gate check", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    const gateState = { lastDreamAt: Date.now(), sessionsSinceDream: 0 };
    await writeFile(join(testDir, ".dream-gate.json"), JSON.stringify(gateState));

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(
      makeDreamFlags({ force: true }),
      makeDeps({
        shouldDream: false, // gate would say no, but --force bypasses
        consolidationResult: { merged: 1, pruned: 0, unchanged: 2, durationMs: 10 },
      }),
    );
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream complete");
  });

  it("lock contention: prints already running message and returns OK", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    // Pre-create lock with live PID + fresh timestamp to simulate an active owner
    await writeFile(join(testDir, ".dream.lock"), `${String(process.pid)}:${String(Date.now())}`);

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(makeDreamFlags({ force: true }), makeDeps());
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("already running");
  });

  it("evicts stale lock owned by dead PID and runs consolidation", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    await writeFile(join(testDir, ".dream.lock"), `99999:${String(Date.now())}`);

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(
      makeDreamFlags({ force: true }),
      makeDeps({ consolidationResult: { merged: 1, pruned: 0, unchanged: 0, durationMs: 0 } }),
    );
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream complete");
  });

  it("--json emits valid JSON with merged/pruned/unchanged keys", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(
      makeDreamFlags({ force: true, json: true }),
      makeDeps({ consolidationResult: { merged: 2, pruned: 1, unchanged: 4, durationMs: 7 } }),
    );
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdoutChunks.join("")) as {
      ok: boolean;
      data: { merged: number; pruned: number; unchanged: number; durationMs: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.merged).toBe(2);
    expect(parsed.data.pruned).toBe(1);
    expect(parsed.data.unchanged).toBe(4);
    expect(typeof parsed.data.durationMs).toBe("number");
  });

  it("successful run: prints merged/pruned/unchanged counts", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";

    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const result = await run(
      makeDreamFlags({ force: true }),
      makeDeps({ consolidationResult: { merged: 3, pruned: 1, unchanged: 5, durationMs: 42 } }),
    );
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    const output = stdoutChunks.join("");
    expect(output).toContain("3 merged");
    expect(output).toContain("1 pruned");
    expect(output).toContain("5 unchanged");
  });
});
