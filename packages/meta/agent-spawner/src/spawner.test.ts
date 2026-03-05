import { describe, expect, mock, test } from "bun:test";
import type {
  ExternalAgentDescriptor,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProcessHandle,
} from "@koi/core";
import { createAgentSpawner } from "./spawner.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockResult(overrides?: Partial<SandboxAdapterResult>): SandboxAdapterResult {
  return {
    exitCode: 0,
    stdout: "agent output",
    stderr: "",
    durationMs: 100,
    timedOut: false,
    oomKilled: false,
    ...overrides,
  };
}

function createMockInstance(
  execResult: SandboxAdapterResult = createMockResult(),
): SandboxInstance {
  return {
    exec: mock(() => Promise.resolve(execResult)),
    readFile: mock(() => Promise.resolve(new Uint8Array())),
    writeFile: mock(() => Promise.resolve()),
    destroy: mock(() => Promise.resolve()),
  };
}

function createMockAdapter(instanceFactory?: () => SandboxInstance): SandboxAdapter {
  const defaultInstance = createMockInstance();
  return {
    name: "mock-adapter",
    create: mock(() => Promise.resolve(instanceFactory ? instanceFactory() : defaultInstance)),
  };
}

const stdioAgent: ExternalAgentDescriptor = {
  name: "test-agent",
  transport: "cli",
  command: "test-cmd",
  capabilities: ["code-generation"],
  source: "path",
};

const acpAgent: ExternalAgentDescriptor = {
  name: "test-acp-agent",
  transport: "cli",
  command: "claude",
  capabilities: ["code-generation"],
  source: "path",
  protocol: "acp",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentSpawner", () => {
  test("stdio happy path — returns agent stdout", async () => {
    const inst = createMockInstance(createMockResult({ stdout: "fixed the bug" }));
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    const result = await spawner.spawn(stdioAgent, "fix the bug");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("fixed the bug");
    }

    await spawner.dispose();
  });

  test("missing command — returns VALIDATION error", async () => {
    const adapter = createMockAdapter();
    const spawner = createAgentSpawner({ adapter });

    const noCmd: ExternalAgentDescriptor = {
      name: "no-cmd",
      transport: "cli",
      capabilities: [],
      source: "path",
    };

    const result = await spawner.spawn(noCmd, "do something");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }

    await spawner.dispose();
  });

  test("timeout — returns TIMEOUT error", async () => {
    const inst = createMockInstance(createMockResult({ timedOut: true, stdout: "" }));
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    const result = await spawner.spawn(stdioAgent, "long task");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }

    await spawner.dispose();
  });

  test("non-zero exit — returns EXTERNAL error", async () => {
    const inst = createMockInstance(createMockResult({ exitCode: 1, stderr: "crash" }));
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    const result = await spawner.spawn(stdioAgent, "fail");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }

    await spawner.dispose();
  });

  test("acp protocol selected when agent has protocol: acp", async () => {
    // ACP path sends stdin and uses --acp flag
    const execMock = mock((_cmd: string, args: readonly string[], _opts?: unknown) => {
      // Verify --acp flag is used
      expect(args).toContain("--acp");
      return Promise.resolve(createMockResult({ stdout: "" }));
    });

    const inst: SandboxInstance = {
      exec: execMock,
      readFile: mock(() => Promise.resolve(new Uint8Array())),
      writeFile: mock(() => Promise.resolve()),
      destroy: mock(() => Promise.resolve()),
    };
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    await spawner.spawn(acpAgent, "do acp");

    expect(execMock).toHaveBeenCalled();
    await spawner.dispose();
  });

  test("undefined protocol falls back to stdio", async () => {
    const execMock = mock((_cmd: string, args: readonly string[], _opts?: unknown) => {
      // Verify --print flag (stdio path)
      expect(args).toContain("--print");
      return Promise.resolve(createMockResult({ stdout: "done" }));
    });

    const inst: SandboxInstance = {
      exec: execMock,
      readFile: mock(() => Promise.resolve(new Uint8Array())),
      writeFile: mock(() => Promise.resolve()),
      destroy: mock(() => Promise.resolve()),
    };
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    const result = await spawner.spawn(stdioAgent, "task");
    expect(result.ok).toBe(true);

    await spawner.dispose();
  });

  test("semaphore limits concurrent calls", async () => {
    // let: track concurrent count
    let concurrent = 0;
    let maxConcurrent = 0;

    const instanceFactory = (): SandboxInstance => {
      const execMock = mock(async () => {
        concurrent++;
        if (concurrent > maxConcurrent) {
          maxConcurrent = concurrent;
        }
        // Simulate some async work
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent--;
        return createMockResult({ stdout: "ok" });
      });

      return {
        exec: execMock,
        readFile: mock(() => Promise.resolve(new Uint8Array())),
        writeFile: mock(() => Promise.resolve()),
        destroy: mock(() => Promise.resolve()),
      };
    };

    const adapter = createMockAdapter(instanceFactory);
    const spawner = createAgentSpawner({
      adapter,
      maxConcurrentDelegations: 1,
    });

    // Launch 3 calls concurrently — only 1 should run at a time
    const results = await Promise.all([
      spawner.spawn(stdioAgent, "task1"),
      spawner.spawn(stdioAgent, "task2"),
      spawner.spawn(stdioAgent, "task3"),
    ]);

    expect(maxConcurrent).toBe(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    await spawner.dispose();
  });

  test("per-spawn instances — each spawn creates and destroys its own instance", async () => {
    const destroyMocks: ReturnType<typeof mock>[] = [];
    const instanceFactory = (): SandboxInstance => {
      const destroyMock = mock(() => Promise.resolve());
      destroyMocks.push(destroyMock);
      return {
        exec: mock(() => Promise.resolve(createMockResult({ stdout: "ok" }))),
        readFile: mock(() => Promise.resolve(new Uint8Array())),
        writeFile: mock(() => Promise.resolve()),
        destroy: destroyMock,
      };
    };

    const adapter = createMockAdapter(instanceFactory);
    const spawner = createAgentSpawner({ adapter });

    await spawner.spawn(stdioAgent, "task1");
    await spawner.spawn(stdioAgent, "task2");

    // adapter.create called twice (per-spawn), each instance destroyed
    expect(adapter.create).toHaveBeenCalledTimes(2);
    expect(destroyMocks.length).toBe(2);
    for (const d of destroyMocks) {
      expect(d).toHaveBeenCalledTimes(1);
    }

    await spawner.dispose();
  });

  test("dispose destroys active instances", async () => {
    // Create a slow spawn to keep instance active during dispose
    const destroyMock = mock(() => Promise.resolve());
    // let: needed to resolve the spawn after dispose
    let resolveExec: ((value: SandboxAdapterResult) => void) | undefined;

    const inst: SandboxInstance = {
      exec: mock(
        () =>
          new Promise<SandboxAdapterResult>((resolve) => {
            resolveExec = resolve;
          }),
      ),
      readFile: mock(() => Promise.resolve(new Uint8Array())),
      writeFile: mock(() => Promise.resolve()),
      destroy: destroyMock,
    };
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    // Start a spawn but don't await it
    const spawnPromise = spawner.spawn(stdioAgent, "long task");

    // Give the spawn time to start and acquire semaphore
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Dispose while spawn is in progress
    await spawner.dispose();

    // Instance should be destroyed by dispose
    expect(destroyMock).toHaveBeenCalled();

    // Resolve the exec to clean up
    resolveExec?.(createMockResult({ stdout: "done" }));
    await spawnPromise;
  });

  test("spawn uses provided profile instead of default", async () => {
    const adapter = createMockAdapter();
    const spawner = createAgentSpawner({ adapter });

    const customProfile = {
      tier: "sandbox" as const,
      filesystem: { allowRead: ["/custom"] },
      network: { allow: false },
      resources: { timeoutMs: 10_000 },
    };

    await spawner.spawn(stdioAgent, "task", { profile: customProfile });

    // adapter.create should have been called with the custom profile
    const createCall = (adapter.create as ReturnType<typeof mock>).mock.calls[0];
    expect(createCall?.[0]).toEqual(customProfile);

    await spawner.dispose();
  });

  test("acp uses interactive spawn() when available", async () => {
    // Create a mock spawn that returns a process handle
    const spawnMock = mock(
      async (): Promise<SandboxProcessHandle> => ({
        pid: 42,
        stdin: {
          write: mock(() => undefined),
          end: mock(() => undefined),
        },
        stdout: new ReadableStream({
          start(controller) {
            // Simulate empty ACP output
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: mock(() => undefined),
      }),
    );

    const inst: SandboxInstance = {
      exec: mock(() => Promise.resolve(createMockResult())),
      spawn: spawnMock,
      readFile: mock(() => Promise.resolve(new Uint8Array())),
      writeFile: mock(() => Promise.resolve()),
      destroy: mock(() => Promise.resolve()),
    };
    const adapter = createMockAdapter(() => inst);
    const spawner = createAgentSpawner({ adapter });

    // Should use spawn() instead of exec() for ACP when available
    await spawner.spawn(acpAgent, "do acp");

    expect(spawnMock).toHaveBeenCalled();
    expect(inst.exec).not.toHaveBeenCalled();

    await spawner.dispose();
  });
});
