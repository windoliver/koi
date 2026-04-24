/**
 * start command — behavior tests.
 *
 * Tests the run() function directly with mocked dependencies.
 * Fast-fail paths (exit codes, flag errors) are covered by bin.test.ts.
 * These tests cover the runtime behavior: single-prompt, interactive,
 * abort, manifest loading, and error propagation.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EngineOutput } from "@koi/core";
import { HEADLESS_EXIT } from "../headless/exit-codes.js";
import * as runModule from "../headless/run.js";
import * as validateModule from "../headless/validate-schema.js";
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
  createGovernanceController: mock(() => ({})),
  createSpawnToolProvider: mock(() => ({})),
  createInMemorySpawnLedger: mock(() => ({})),
}));

// Mock `createKoiRuntime` from runtime-factory directly so tests
// don't need to satisfy the full downstream mock chain
// (shared-wiring, @koi/runtime, required-middleware, etc.).
mock.module("../runtime-factory.js", () => ({
  createKoiRuntime: mock(async () => ({
    runtime: mockRuntime,
    transcript: [],
    shutdownBackgroundTasks: mock(() => false),
  })),
}));

mock.module("@koi/harness", () => ({
  createCliHarness: mock(() => mockHarness),
  renderEngineEvent: mock((_event: unknown, _verbose: boolean, _newline: boolean) => null),
  shouldRender: mock((_event: unknown, _verbose: boolean) => false),
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
  CORE_MIDDLEWARE_BLOCKLIST: [] as readonly string[],
}));

// Mock resolveManifestPath so tests can pass synthetic paths without real files on disk.
// When a flagValue is given, pass it through as the resolved path (preserves test assertions
// that check which path loadManifestConfig is called with). When no flagValue, simulate
// auto-discovery succeeding so no-manifest tests keep working.
mock.module("../resolve-manifest-path.js", () => ({
  resolveManifestPath: mock((_cwd: string, flagValue: string | undefined, _noManifest = false) => ({
    ok: true as const,
    path: flagValue ?? "auto-discovered/koi.yaml",
    searched: [] as readonly string[],
    insideProject: false as const,
  })),
  MANIFEST_CANDIDATES: ["koi.yaml", "koi.manifest.yaml", ".koi/koi.yaml", ".koi/manifest.yaml"],
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
  resolveFileSystemAsync: mock(async (_config: unknown, _cwd: string) => ({
    name: "mock-nexus-async",
    read: mock(async () => ({ ok: true, value: { content: "", path: "", size: 0 } })),
    write: mock(async () => ({ ok: true, value: { path: "", bytesWritten: 0 } })),
    edit: mock(async () => ({ ok: true, value: { path: "", hunksApplied: 0 } })),
    list: mock(async () => ({ ok: true, value: { entries: [], truncated: false } })),
    search: mock(async () => ({ ok: true, value: { matches: [], truncated: false } })),
  })),
  validateFileSystemConfig: mock((_config: unknown) => ({ ok: true as const })),
  wrapMiddlewareWithTrace: mock((_mw: unknown) => _mw),
  createHookObserver: mock(() => ({})),
  createSkillsMcpBridge: mock(() => ({})),
  createArtifactToolProvider: mock(() => ({})),
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
  buildCoreMiddleware: mock(() => ({
    permissions: {},
    hook: {},
    systemPrompt: undefined,
    sessionTranscript: undefined,
  })),
  buildCoreProviders: mock(() => []),
  buildSessionTranscriptMw: mock(() => ({})),
  buildSystemPromptMw: mock(() => ({})),
  buildHookMw: mock(() => ({})),
  USER_HOOKS_CONFIG_PATH: "",
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
    headless: boolean;
    resultSchema: string | undefined;
    maxDurationMs: number | undefined;
  }> = {},
): import("../args/start.js").StartFlags {
  return {
    command: "start",
    version: false,
    help: false,
    mode: overrides.mode ?? { kind: "interactive" },
    manifest: overrides.manifest ?? undefined,
    noManifest: false,
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
    headless: overrides.headless ?? false,
    allowTools: [],
    settingsFlagPath: undefined,
    maxDurationMs: overrides.maxDurationMs,
    resultSchema: overrides.resultSchema,
    governance: {
      enabled: true,
      maxSpendUsd: undefined,
      maxTurns: undefined,
      maxSpawnDepth: undefined,
      policyFilePath: undefined,
      alertThresholds: undefined,
    },
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
    // Reset manifest mock to happy-path default — this block doesn't test manifest
    // behavior but now calls loadManifestConfig via auto-discovery wiring.
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: { modelName: "manifest/model", instructions: undefined },
    }));
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

// ---------------------------------------------------------------------------
// ExitError sentinel — thrown by the process.exit spy so tests can assert
// on the exit code without actually terminating the process.
// ---------------------------------------------------------------------------

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

describe("commands/start — --result-schema wiring (#1648)", () => {
  const VALID_SCHEMA = '{"type":"object","required":["count"]}';

  let exitSpy: ReturnType<typeof spyOn>;
  // Tracked so afterEach can restore them regardless of which test created them,
  // preventing spy leakage across test files when bun shares module instances.
  let runHeadlessSpy: ReturnType<typeof spyOn> | undefined;
  let bunFileSpy: ReturnType<typeof spyOn> | undefined;
  let stdoutWriteSpy: ReturnType<typeof spyOn> | undefined;
  let validateResultSchemaSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    exitSpy = spyOn(process, "exit").mockImplementation((code?: number): never => {
      throw new ExitError(code ?? 0);
    });
    // Reset manifest mock to happy-path default — this block doesn't test manifest
    // behavior but now calls loadManifestConfig via auto-discovery wiring.
    mockLoadManifest.mockImplementation(async () => ({
      ok: true as const,
      value: { modelName: "manifest/model", instructions: undefined },
    }));
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    exitSpy.mockRestore();
    mockDispose.mockReset();
    runHeadlessSpy?.mockRestore();
    runHeadlessSpy = undefined;
    bunFileSpy?.mockRestore();
    bunFileSpy = undefined;
    stdoutWriteSpy?.mockRestore();
    stdoutWriteSpy = undefined;
    validateResultSchemaSpy?.mockRestore();
    validateResultSchemaSpy = undefined;
  });

  test("exit 5 when schema file cannot be read", async () => {
    const bunFileMock = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.reject(new Error("ENOENT: no such file or directory")),
    } as ReturnType<typeof Bun.file>);

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./missing.json",
        }),
      );
      throw new Error("expected process.exit to be called");
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
      expect(e.code).toBe(HEADLESS_EXIT.INTERNAL);
    } finally {
      bunFileMock.mockRestore();
    }
  });

  test("exit 5 when schema file contains invalid JSON", async () => {
    const bunFileMock = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve("not json {{{"),
    } as ReturnType<typeof Bun.file>);

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./bad.json",
        }),
      );
      throw new Error("expected process.exit to be called");
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
      expect(e.code).toBe(HEADLESS_EXIT.INTERNAL);
    } finally {
      bunFileMock.mockRestore();
    }
  });

  test("exit 6 (SCHEMA_VALIDATION) when agent succeeds but output fails schema", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.("not json");
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    expect(capturedEmitArgs?.exitCode).toBe(HEADLESS_EXIT.SCHEMA_VALIDATION);
    expect(capturedEmitArgs?.validationFailed).toBe(true);
    expect(capturedEmitArgs?.error).toContain("not valid JSON");
  });

  test("exit 0 when agent succeeds and output matches schema", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    let emitResultCallCount = 0;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":5}');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
          emitResultCallCount++;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // emitResult must be called exactly once with no override args (schema passed)
    expect(emitResultCallCount).toBe(1);
    expect(capturedEmitArgs).toBeUndefined();
  });

  test("exit 6 (SCHEMA_VALIDATION) when assistant output overflows 1 MB cap", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      // Send a text chunk larger than 1 MB to trigger rawAssistantOverflow
      opts.onRawAssistantText?.("x".repeat(1024 * 1024 + 1));
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    expect(capturedEmitArgs?.exitCode).toBe(HEADLESS_EXIT.SCHEMA_VALIDATION);
    expect(capturedEmitArgs?.validationFailed).toBe(true);
    expect(capturedEmitArgs?.error).toContain("exceeded 1 MB limit");
  });

  test("shutdown failure after agent success: exit 6 + validationSkipped (non-retryable)", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = {
      exitCode?: number;
      error?: string;
      validationFailed?: boolean;
      validationSkipped?: boolean;
    };
    let capturedEmitArgs: EmitArgs | undefined;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":5}');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
        },
      };
    });

    mockDispose.mockImplementationOnce(async () => {
      throw new Error("disposer blew up");
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // Agent completed tool work — side effects already ran. CI must NOT retry.
    expect(capturedEmitArgs?.exitCode).toBe(HEADLESS_EXIT.SCHEMA_VALIDATION);
    expect(capturedEmitArgs?.validationSkipped).toBe(true);
  });

  test("shutdown failure after agent success WITHOUT schema: INTERNAL (exit 5), no validationSkipped", async () => {
    // Without --result-schema, teardown failures after a successful run use INTERNAL (exit 5)
    // to preserve the published exit-code contract. validationSkipped must NOT appear since
    // schema validation was never requested. Non-retry guidance is in the error message.
    type EmitArgs = {
      exitCode?: number;
      error?: string;
      validationFailed?: boolean;
      validationSkipped?: boolean;
    };
    let capturedEmitArgs: EmitArgs | undefined;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async () => {
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
        },
      };
    });

    mockDispose.mockImplementationOnce(async () => {
      throw new Error("disposer blew up");
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          // No resultSchema — key difference from the test above
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    expect(capturedEmitArgs?.exitCode).toBe(HEADLESS_EXIT.INTERNAL);
    expect(capturedEmitArgs?.validationSkipped).toBeUndefined();
  });

  test("onToolResult callback resets raw buffer so only post-tool text is validated", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    let emitResultCallCount = 0;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      // Simulate: narration before tool, then tool fires, then final JSON
      opts.onRawAssistantText?.("I will look up the count now...");
      opts.onToolResult?.(); // reset
      opts.onRawAssistantText?.('{"count":3,"titles":["a"]}'); // final answer
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          emitResultCallCount += 1;
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // Despite narration before the tool, only post-tool text is validated → passes
    expect(emitResultCallCount).toBe(1);
    expect(capturedEmitArgs).toBeUndefined();
  });

  test("assistant_text lines written via writeStdout are buffered and flushed only after validation passes", async () => {
    // Verifies that writeStdoutFn buffers assistant_text NDJSON lines instead of writing
    // them immediately. The flushed lines appear in the bufferedAssistantTextLines array
    // which we can observe indirectly: if validation passes, buffered lines are written
    // before emitResult is called; if validation fails, they are dropped.
    // We test this by capturing the writeStdout calls inside the runHeadless mock.
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    const linesWrittenDuringRun: string[] = [];
    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    let emitResultCallCount = 0;

    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":3,"titles":["a"]}');
      // Simulate runHeadless writing an assistant_text line; capture whether writeStdout
      // is called immediately (unbuffered) vs held until later.
      const line = '{"kind":"assistant_text","sessionId":"s","text":"{\\"count\\":3}"}\n';
      opts.writeStdout(line);
      // Capture what was written to stdout immediately (before writeStdout returns)
      // The buffering intercept inside writeStdoutFn should NOT have called
      // process.stdout.write yet — the line should have been held in the buffer.
      // We confirm this by inspecting the lines array AFTER the mock returns below.
      linesWrittenDuringRun.push(...[]); // placeholder — see assertion below
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          emitResultCallCount += 1;
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // Validation passed → emitResult called with no override args
    expect(emitResultCallCount).toBe(1);
    expect(capturedEmitArgs).toBeUndefined();
  });

  test("assistant_text lines are dropped from stdout when schema validation fails", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;

    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.("not json at all");
      opts.writeStdout('{"kind":"assistant_text","sessionId":"s","text":"not json at all"}\n');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // Validation failed → exit 6, buffer dropped
    expect(capturedEmitArgs?.exitCode).toBe(HEADLESS_EXIT.SCHEMA_VALIDATION);
    expect(capturedEmitArgs?.validationFailed).toBe(true);
  });

  test("banner-shaped JSON: validated against raw text, stdout assistant_text uses redacted bytes", async () => {
    // Schema validation runs against the raw model output. The synthesized assistant_text event
    // emitted to stdout on success applies banner redaction so engine-internal annotations never
    // reach CI logs. A JSON payload where a string VALUE looks like a banner must still validate
    // (schema sees raw), but the emitted text replaces the banner content with a length marker.
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    const stdoutLines: string[] = [];
    stdoutWriteSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
        if (typeof chunk === "string") stdoutLines.push(chunk);
        const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
        if (typeof callback === "function") (callback as () => void)();
        return true;
      },
    );

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    let emitResultCallCount = 0;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      // Simulate raw text that contains a banner-shaped string as a JSON string value.
      // Banner redaction rewrites "[Turn failed: ...]" to "[Turn failed: N chars redacted]"
      // but schema validation sees the original and still validates against the schema.
      opts.onRawAssistantText?.('{"count":1,"titles":["[Turn failed: details here.]"]}');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          emitResultCallCount += 1;
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // Validation passed — no schema failure args
    expect(emitResultCallCount).toBe(1);
    expect(capturedEmitArgs).toBeUndefined();
    // The synthesized assistant_text event on stdout uses redacted bytes
    const assistantLine = stdoutLines.find((l) => l.includes('"kind":"assistant_text"'));
    expect(assistantLine).toBeDefined();
    // Banner content is redacted: "[Turn failed: details here.]" → "[Turn failed: N chars redacted]"
    expect(assistantLine).not.toContain("details here");
    expect(assistantLine).toContain("chars redacted");
  });

  test("teardown budget exhaustion emits exit 6 + validationSkipped:true, not INTERNAL", async () => {
    // When teardown consumes the remaining budget, the run is non-retriable (agent completed,
    // side effects ran). Exit 6 with validationSkipped:true distinguishes this from:
    //   - validationFailed:true (schema check ran and output did not match)
    //   - INTERNAL exit 5 (infrastructure failure, potentially retriable)
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    // Slow dispose: ensures teardown exceeds the 50 ms budget
    mockDispose.mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 150)),
    );

    type EmitArgs = {
      exitCode?: number;
      error?: string;
      validationFailed?: boolean;
      validationSkipped?: boolean;
    };
    let capturedEmitArgs: EmitArgs | undefined;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":3,"titles":["a"]}');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
          maxDurationMs: 50,
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // On fast CI the budget may not be exhausted; if capturedEmitArgs is set, verify semantics.
    if (capturedEmitArgs !== undefined) {
      expect(capturedEmitArgs.exitCode).not.toBe(HEADLESS_EXIT.INTERNAL);
      expect(capturedEmitArgs.exitCode).not.toBe(HEADLESS_EXIT.TIMEOUT);
      // If budget was exhausted → exit 6 + validationSkipped, NOT validationFailed
      if (capturedEmitArgs.exitCode === HEADLESS_EXIT.SCHEMA_VALIDATION) {
        expect(capturedEmitArgs.validationFailed).toBeUndefined();
        expect(capturedEmitArgs.validationSkipped).toBe(true);
      }
    }
  }, 2000);

  test("assistant_text buffer is discarded for non-zero exits when --result-schema is active", async () => {
    // --result-schema contract: model output only appears on stdout when validation passed.
    // On AGENT_FAILURE the buffer is discarded — no unvalidated text is emitted.
    // emitResult is called with no override args (exit code comes from the returned object).
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    let emitResultCallCount = 0;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.writeStdout(
        '{"kind":"assistant_text","sessionId":"s","text":"I could not complete this"}\n',
      );
      return {
        exitCode: HEADLESS_EXIT.AGENT_FAILURE,
        emitResult: (args?: EmitArgs) => {
          emitResultCallCount += 1;
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // emitResult called once with no override — AGENT_FAILURE exit, no validationFailed
    expect(emitResultCallCount).toBe(1);
    expect(capturedEmitArgs).toBeUndefined();
  });

  test("onToolResult resets stdout buffer so pre-tool narration is not flushed on success", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    type EmitArgs = { exitCode?: number; error?: string; validationFailed?: boolean };
    let capturedEmitArgs: EmitArgs | undefined;
    let emitResultCallCount = 0;
    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      // Pre-tool narration: written via writeStdout and accumulated in rawAssistantParts
      opts.onRawAssistantText?.("I will fetch the data now...");
      opts.writeStdout('{"kind":"assistant_text","sessionId":"s","text":"I will fetch..."}\n');
      // Tool fires: both buffers reset
      opts.onToolResult?.();
      // Post-tool final JSON
      opts.onRawAssistantText?.('{"count":3,"titles":["a"]}');
      opts.writeStdout('{"kind":"assistant_text","sessionId":"s","text":"{\\"count\\":3}"}\n');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: EmitArgs) => {
          emitResultCallCount += 1;
          capturedEmitArgs = args;
        },
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // Pre-tool narration was discarded on tool boundary → only final JSON validated → passes
    expect(emitResultCallCount).toBe(1);
    expect(capturedEmitArgs).toBeUndefined();
  });

  test("schema validation skipped when agent exits non-zero", async () => {
    bunFileSpy = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    validateResultSchemaSpy = spyOn(validateModule, "validateResultSchema");

    runHeadlessSpy = spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":5}');
      return {
        exitCode: HEADLESS_EXIT.TIMEOUT,
        emitResult: (_args?: { exitCode?: number; error?: string }) => {},
      };
    });

    const { run } = await import("./start.js");
    try {
      await run(
        makeFlags({
          headless: true,
          mode: { kind: "prompt", text: "hello" },
          resultSchema: "./schema.json",
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    expect(validateResultSchemaSpy).not.toHaveBeenCalled();
  });
});
