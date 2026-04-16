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

// Mock resolveFileSystem from @koi/runtime so nexus gate tests don't
// try to create real nexus backends.
const mockResolveFileSystem = mock((_config: unknown, _cwd: string) => ({
  name: "mock-nexus",
  read: mock(async () => ({ ok: true, value: { content: "", path: "", size: 0 } })),
  write: mock(async () => ({ ok: true, value: { path: "", bytesWritten: 0 } })),
  edit: mock(async () => ({ ok: true, value: { path: "", hunksApplied: 0 } })),
  list: mock(async () => ({ ok: true, value: { entries: [], truncated: false } })),
  search: mock(async () => ({ ok: true, value: { matches: [], truncated: false } })),
}));

mock.module("@koi/runtime", () => ({
  resolveFileSystem: mockResolveFileSystem,
}));

// Mock @koi/session so tests don't touch the filesystem. We
// retain a mock for the raw `resumeForSession` API so other
// codepaths that call it directly still work.
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

// Mock the shared-wiring helper `resumeSessionFromJsonl` so
// start.ts's resume flow is testable without touching the real
// `~/.koi/sessions` directory. The real helper probes
// `Bun.file(...).exists()` before reading the transcript, and
// hand-crafting real JSONL files just to satisfy the existence
// probe in a unit test would be wasteful and brittle — routing
// through a module mock lets each test shape the resume outcome
// directly.
type ResumeSessionFromJsonlResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly sid: unknown;
        readonly messages: readonly unknown[];
        readonly issueCount: number;
      };
    }
  | { readonly ok: false; readonly error: string };
const mockResumeSessionFromJsonl = mock(
  async (
    _rawId: string,
    _transcript: unknown,
    _dir: string,
  ): Promise<ResumeSessionFromJsonlResult> => ({
    ok: true,
    value: { sid: "mock-sid", messages: [], issueCount: 0 },
  }),
);
mock.module("../shared-wiring.js", () => ({
  buildPluginMcpSetup: mock(() => undefined),
  loadUserMcpSetup: mock(async () => undefined),
  loadUserRegisteredHooks: mock(async () => []),
  mergeUserAndPluginHooks: mock((u: unknown[], _p: unknown[]) => u),
  resumeSessionFromJsonl: mockResumeSessionFromJsonl,
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
    allowRemoteFs: boolean;
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
    allowRemoteFs: overrides.allowRemoteFs ?? false,
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
    mockResumeSessionFromJsonl.mockReset();
    mockRunInteractive.mockReset();
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("resumes session and returns OK when the resume helper succeeds", async () => {
    mockResumeSessionFromJsonl.mockImplementation(async () => ({
      ok: true as const,
      value: {
        sid: "ses_abc",
        messages: [
          {
            senderId: "user",
            timestamp: 1,
            content: [{ kind: "text", text: "hi" }],
          },
        ],
        issueCount: 0,
      },
    }));
    mockRunInteractive.mockImplementation(async () => {});
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ resume: "ses_abc" }));
    expect(result).toBe(ExitCode.OK);
    expect(mockResumeSessionFromJsonl).toHaveBeenCalledTimes(1);
  });

  test("returns FAILURE when the resume helper reports missing transcript", async () => {
    // The helper fails closed for nonexistent files (based on
    // Bun.file(...).exists() in shared-wiring). Start.ts surfaces
    // that as an explicit failure so the user doesn't fork into a
    // blank session under a typoed id.
    mockResumeSessionFromJsonl.mockImplementation(async () => ({
      ok: false as const,
      error: 'no transcript found for session id "ses_typo"',
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ resume: "ses_typo" }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("returns FAILURE when the resume helper errors", async () => {
    mockResumeSessionFromJsonl.mockImplementation(async () => ({
      ok: false as const,
      error: "session not found",
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ resume: "ses_missing" }));
    expect(result).toBe(ExitCode.FAILURE);
  });
});

describe("run() — nexus two-gate trust boundary", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    mockLoadManifest.mockReset();
    mockRunSinglePrompt.mockImplementation(async () => completedOutput());
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  test("gate 1 fails: nexus without root and mode → FAILURE", async () => {
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: {
        modelName: "gpt-4",
        instructions: undefined,
        stacks: undefined,
        plugins: undefined,
        middleware: undefined,
        backgroundSubprocesses: undefined,
        filesystem: { backend: "nexus" as const, options: undefined, operations: undefined },
      },
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ manifest: "koi.yaml" }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("gate 1 fails: nexus with root but missing mode → FAILURE", async () => {
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: {
        modelName: "gpt-4",
        instructions: undefined,
        stacks: undefined,
        plugins: undefined,
        middleware: undefined,
        backgroundSubprocesses: undefined,
        filesystem: {
          backend: "nexus" as const,
          options: { root: "/data", mountUri: "local://data" },
          operations: undefined,
        },
      },
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ manifest: "koi.yaml" }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("gate 2 fails: nexus with scope but without --allow-remote-fs → FAILURE", async () => {
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: {
        modelName: "gpt-4",
        instructions: undefined,
        stacks: undefined,
        plugins: undefined,
        middleware: undefined,
        backgroundSubprocesses: undefined,
        filesystem: {
          backend: "nexus" as const,
          options: { root: "/data/workspace", mode: "ro" },
          operations: undefined,
        },
      },
    }));
    const { run } = await import("./start.js");
    const result = await run(makeFlags({ manifest: "koi.yaml", allowRemoteFs: false }));
    expect(result).toBe(ExitCode.FAILURE);
  });

  test("both gates pass: nexus with scope and --allow-remote-fs → proceeds past nexus check", async () => {
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: {
        modelName: "gpt-4",
        instructions: undefined,
        stacks: undefined,
        plugins: undefined,
        middleware: undefined,
        backgroundSubprocesses: undefined,
        filesystem: {
          backend: "nexus" as const,
          options: { root: "/data/workspace", mode: "rw" },
          operations: ["read" as const, "write" as const],
        },
      },
    }));
    mockRunInteractive.mockImplementation(async () => {});
    const { run } = await import("./start.js");
    // Should not return FAILURE due to nexus gate — the run proceeds
    // to runtime assembly (which uses mocked dependencies) and succeeds.
    const result = await run(makeFlags({ manifest: "koi.yaml", allowRemoteFs: true }));
    expect(result).toBe(ExitCode.OK);
  });
});
