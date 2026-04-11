/**
 * start command — behavior tests.
 *
 * Tests the run() function directly with mocked dependencies.
 * Fast-fail paths (exit codes, flag errors) are covered by bin.test.ts.
 * These tests cover the runtime behavior: single-prompt, interactive,
 * abort, manifest loading, and error propagation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EngineOutput } from "@koi/core";
import { ExitCode } from "../types.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/** Minimal EngineOutput for a completed turn. */
function completedOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: { totalTokens: 10, inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 0 },
  };
}

/** Minimal EngineOutput for an interrupted turn. */
function interruptedOutput(): EngineOutput {
  return {
    content: [],
    stopReason: "interrupted",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  };
}

// Mock harness
const mockRunSinglePrompt = mock(async (_text: string) => completedOutput());
const mockRunInteractive = mock(async () => {});
const mockHarness = {
  runSinglePrompt: mockRunSinglePrompt,
  runInteractive: mockRunInteractive,
};

// Mock runtime
const mockDispose = mock(async () => {});
const mockRun = mock(async function* () {});
const mockRuntime = { run: mockRun, dispose: mockDispose };

// ---------------------------------------------------------------------------
// Module mocks — must be set up before importing the module under test.
// Use dynamic import inside each test to get a fresh module with the mock.
// ---------------------------------------------------------------------------

// We use module-level mocking via bun:test's mock.module()
// to intercept @koi/engine, @koi/harness, etc.
// The mocks are applied once before all tests in this file.

mock.module("@koi/engine", () => ({
  createKoi: mock(async () => mockRuntime),
  createSystemPromptMiddleware: mock((_prompt: string) => ({})),
}));

mock.module("@koi/harness", () => ({
  createCliHarness: mock(() => mockHarness),
}));

mock.module("@koi/channel-cli", () => ({
  createCliChannel: mock(() => ({})),
}));

mock.module("@koi/model-openai-compat", () => ({
  createOpenAICompatAdapter: mock(() => ({
    complete: mock(async () => ({})),
    stream: mock(async function* () {}),
  })),
}));

mock.module("@koi/query-engine", () => ({
  runTurn: mock(async function* () {}),
}));

// Mock loadManifestConfig — typed as the full union so mockImplementation can return either branch
type ManifestResult =
  | {
      readonly ok: true;
      readonly value: { readonly modelName: string; readonly instructions: string | undefined };
    }
  | { readonly ok: false; readonly error: string };
const mockLoadManifest = mock(
  async (_path: string): Promise<ManifestResult> => ({
    ok: true,
    value: { modelName: "manifest/model", instructions: undefined },
  }),
);

mock.module("../manifest.js", () => ({
  loadManifestConfig: mockLoadManifest,
}));

// Mock @koi/session so tests don't touch the filesystem
type ResumeSessionResult =
  | {
      readonly ok: true;
      readonly value: { readonly messages: readonly never[]; readonly issues: readonly never[] };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly message: string;
        readonly code: string;
        readonly retryable: boolean;
      };
    };
const mockResumeForSession = mock(
  async (_sid: unknown, _transcript: unknown): Promise<ResumeSessionResult> => ({
    ok: true,
    value: { messages: [], issues: [] },
  }),
);
mock.module("@koi/session", () => ({
  createJsonlTranscript: mock(() => ({})),
  createSessionTranscriptMiddleware: mock(() => ({})),
  resumeForSession: mockResumeForSession,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Helper: build minimal StartFlags
function makeFlags(
  overrides: Partial<{
    mode: { kind: "interactive" } | { kind: "prompt"; text: string };
    manifest: string | undefined;
    resume: string | undefined;
    verbose: boolean;
    dryRun: boolean;
    logFormat: "text" | "json";
    noTui: boolean;
    contextWindow: number;
  }> = {},
): import("../args/start.js").StartFlags {
  return {
    command: "start",
    version: false,
    help: false,
    mode: overrides.mode ?? { kind: "interactive" },
    manifest: overrides.manifest ?? undefined,
    resume: overrides.resume ?? undefined,
    verbose: overrides.verbose ?? false,
    dryRun: overrides.dryRun ?? false,
    logFormat: overrides.logFormat ?? "text",
    noTui: overrides.noTui ?? false,
    contextWindow: overrides.contextWindow ?? 100,
    untilPass: [],
    maxIter: 10,
    verifierTimeoutMs: 120_000,
    workingDir: undefined,
    allowSideEffects: false,
    verifierInheritEnv: false,
  };
}

describe("run() — early exits", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    mockRunSinglePrompt.mockReset();
    mockRunInteractive.mockReset();
  });

  test("returns FAILURE when dryRun is set", async () => {
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ dryRun: true }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("returns FAILURE when logFormat is json", async () => {
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ logFormat: "json" }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("returns FAILURE when no API key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { run } = await import("./start.js");
    const result = await run(makeFlags());
    expect(result).toBe(ExitCode.FAILURE);
  });
});

describe("run() — single-prompt mode", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    mockRunSinglePrompt.mockReset();
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("calls runSinglePrompt and returns OK on completed", async () => {
    mockRunSinglePrompt.mockImplementation(async () => completedOutput());
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ mode: { kind: "prompt", text: "hello" } }));
    expect(result).toBe(ExitCode.OK);
    expect(mockRunSinglePrompt).toHaveBeenCalledTimes(1);
  });

  test("returns FAILURE when stopReason is not completed", async () => {
    mockRunSinglePrompt.mockImplementation(async () => interruptedOutput());
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ mode: { kind: "prompt", text: "hello" } }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("returns FAILURE when runSinglePrompt throws", async () => {
    mockRunSinglePrompt.mockImplementation(async () => {
      throw new Error("adapter error");
    });
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ mode: { kind: "prompt", text: "hello" } }));
    expect(result).toBe(ExitCode.FAILURE);
  });
});

describe("run() — interactive mode", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    mockRunInteractive.mockReset();
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("calls runInteractive and returns OK", async () => {
    mockRunInteractive.mockImplementation(async () => {});
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ mode: { kind: "interactive" } }));
    expect(result).toBe(ExitCode.OK);
    expect(mockRunInteractive).toHaveBeenCalledTimes(1);
  });

  test("returns FAILURE when runInteractive throws", async () => {
    mockRunInteractive.mockImplementation(async () => {
      throw new Error("channel disconnected");
    });
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ mode: { kind: "interactive" } }));
    expect(result).toBe(ExitCode.FAILURE);
  });
});

describe("run() — manifest loading", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    mockLoadManifest.mockReset();
    mockRunSinglePrompt.mockImplementation(async () => completedOutput());
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("loads manifest when --manifest flag is set", async () => {
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: { modelName: "manifest/model", instructions: undefined },
    }));
    const { run } = await import("./start.js");
    await run(makeFlags({ manifest: "koi.yaml", mode: { kind: "prompt", text: "hi" } }));
    expect(mockLoadManifest).toHaveBeenCalledWith("koi.yaml");
  });

  test("returns FAILURE when manifest is invalid", async () => {
    mockLoadManifest.mockImplementation(async () => ({
      ok: false as const,
      error: "manifest.model is required",
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ manifest: "bad.yaml" }));
    expect(result).toBe(ExitCode.FAILURE);
  });
});

describe("run() — session resume", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    mockResumeForSession.mockReset();
    mockRunInteractive.mockReset();
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("resumes session and returns OK when resumeForSession succeeds", async () => {
    mockResumeForSession.mockImplementation(async () => ({
      ok: true as const,
      value: { messages: [], issues: [] },
    }));
    mockRunInteractive.mockImplementation(async () => {});
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ resume: "ses_abc" }));
    expect(result).toBe(ExitCode.OK);
    expect(mockResumeForSession).toHaveBeenCalledTimes(1);
  });

  test("returns FAILURE when resumeForSession fails", async () => {
    mockResumeForSession.mockImplementation(async () => ({
      ok: false as const,
      error: { message: "session not found", code: "NOT_FOUND", retryable: false },
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ resume: "ses_missing" }));
    expect(result).toBe(ExitCode.FAILURE);
  });
});
