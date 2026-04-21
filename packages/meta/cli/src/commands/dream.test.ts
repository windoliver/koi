/**
 * Tests for `koi dream` command.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../types.js";

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
// Command: run() with real filesystem + mocked heavy deps
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
    const { run } = await import("./dream.js");
    const result = await run({ command: "doctor", version: false, help: false });
    expect(result).toBe(ExitCode.FAILURE);
  });

  it("returns FAILURE when no API key available", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const { run } = await import("./dream.js");
    const stderrChunks: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const result = await run(makeDreamFlags());

    spy.mockRestore();
    expect(result).toBe(ExitCode.FAILURE);
    expect(stderrChunks.join("")).toContain("no API key");
  });

  it("gate skip: prints message and returns OK when gate not triggered", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    const gateState = { lastDreamAt: Date.now(), sessionsSinceDream: 0 };
    await writeFile(join(testDir, ".dream-gate.json"), JSON.stringify(gateState));

    const { run } = await import("./dream.js");
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await run(makeDreamFlags({ force: false }));

    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream gate not triggered");
  });

  it("--force bypasses gate check", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    const gateState = { lastDreamAt: Date.now(), sessionsSinceDream: 0 };
    await writeFile(join(testDir, ".dream-gate.json"), JSON.stringify(gateState));

    mock.module("@koi/dream", () => ({
      shouldDream: () => false,
      runDreamConsolidation: async () => ({ merged: 1, pruned: 0, unchanged: 2, durationMs: 10 }),
    }));
    mock.module("@koi/memory-fs", () => ({
      createMemoryStore: () => ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }),
    }));
    mock.module("@koi/model-openai-compat", () => ({
      createOpenAICompatAdapter: () => ({ complete: async () => ({ content: "", model: "test" }) }),
    }));

    const mod = await import(`./dream.js?t=${String(Date.now())}`);
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await (mod as { run: (f: unknown) => Promise<number> }).run(
      makeDreamFlags({ force: true }),
    );

    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).not.toContain("gate not triggered");
    expect(stdoutChunks.join("")).toContain("Dream complete");
  });

  it("lock contention: prints already running message and returns OK", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    // Pre-create lock with live PID + fresh timestamp to simulate an active owner
    await writeFile(join(testDir, ".dream.lock"), `${String(process.pid)}:${String(Date.now())}`);

    mock.module("@koi/dream", () => ({
      shouldDream: () => true,
      runDreamConsolidation: async () => ({ merged: 0, pruned: 0, unchanged: 0, durationMs: 0 }),
    }));
    mock.module("@koi/memory-fs", () => ({
      createMemoryStore: () => ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }),
    }));
    mock.module("@koi/model-openai-compat", () => ({
      createOpenAICompatAdapter: () => ({ complete: async () => ({ content: "", model: "test" }) }),
    }));

    const mod = await import(`./dream.js?t=${String(Date.now())}`);
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await (mod as { run: (f: unknown) => Promise<number> }).run(
      makeDreamFlags({ force: true }),
    );

    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("already running");
  });

  it("OPENAI_API_KEY works when OPENROUTER_API_KEY is unset", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-test";

    mock.module("@koi/dream", () => ({
      shouldDream: () => true,
      runDreamConsolidation: async () => ({ merged: 0, pruned: 0, unchanged: 0, durationMs: 0 }),
    }));
    mock.module("@koi/memory-fs", () => ({
      createMemoryStore: () => ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }),
    }));
    mock.module("@koi/model-openai-compat", () => ({
      createOpenAICompatAdapter: () => ({ complete: async () => ({ content: "", model: "test" }) }),
    }));

    const mod = await import(`./dream.js?t=${String(Date.now())}`);
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await (mod as { run: (f: unknown) => Promise<number> }).run(
      makeDreamFlags({ force: true }),
    );
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream complete");
  });

  it("--json emits valid JSON with merged/pruned/unchanged keys", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";

    mock.module("@koi/dream", () => ({
      shouldDream: () => true,
      runDreamConsolidation: async () => ({ merged: 2, pruned: 1, unchanged: 4, durationMs: 7 }),
    }));
    mock.module("@koi/memory-fs", () => ({
      createMemoryStore: () => ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }),
    }));
    mock.module("@koi/model-openai-compat", () => ({
      createOpenAICompatAdapter: () => ({ complete: async () => ({ content: "", model: "test" }) }),
    }));

    const mod = await import(`./dream.js?t=${String(Date.now())}`);
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await (mod as { run: (f: unknown) => Promise<number> }).run(
      makeDreamFlags({ force: true, json: true }),
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

  it("evicts stale lock owned by dead PID and runs consolidation", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";
    await writeFile(join(testDir, ".dream.lock"), `99999:${String(Date.now())}`);

    mock.module("@koi/dream", () => ({
      shouldDream: () => true,
      runDreamConsolidation: async () => ({ merged: 1, pruned: 0, unchanged: 0, durationMs: 0 }),
    }));
    mock.module("@koi/memory-fs", () => ({
      createMemoryStore: () => ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }),
    }));
    mock.module("@koi/model-openai-compat", () => ({
      createOpenAICompatAdapter: () => ({ complete: async () => ({ content: "", model: "test" }) }),
    }));

    const mod = await import(`./dream.js?t=${String(Date.now())}`);
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await (mod as { run: (f: unknown) => Promise<number> }).run(
      makeDreamFlags({ force: true }),
    );
    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    expect(stdoutChunks.join("")).toContain("Dream complete");
  });

  it("error message no longer references removed --api-key flag", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const { run } = await import("./dream.js");
    const stderrChunks: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    await run(makeDreamFlags());
    spy.mockRestore();
    const out = stderrChunks.join("");
    expect(out).not.toContain("--api-key");
    expect(out).toContain("environment variable");
  });

  it("successful run: prints merged/pruned/unchanged counts", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-key";

    mock.module("@koi/dream", () => ({
      shouldDream: () => true,
      runDreamConsolidation: async () => ({ merged: 3, pruned: 1, unchanged: 5, durationMs: 42 }),
    }));
    mock.module("@koi/memory-fs", () => ({
      createMemoryStore: () => ({
        list: async () => [],
        write: async () => ({ action: "created", record: {} }),
        delete: async () => ({ deleted: true }),
      }),
    }));
    mock.module("@koi/model-openai-compat", () => ({
      createOpenAICompatAdapter: () => ({ complete: async () => ({ content: "", model: "test" }) }),
    }));

    const mod = await import(`./dream.js?t=${String(Date.now())}`);
    const stdoutChunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const result = await (mod as { run: (f: unknown) => Promise<number> }).run(
      makeDreamFlags({ force: true }),
    );

    spy.mockRestore();
    expect(result).toBe(ExitCode.OK);
    const output = stdoutChunks.join("");
    expect(output).toContain("3 merged");
    expect(output).toContain("1 pruned");
    expect(output).toContain("5 unchanged");
  });
});
