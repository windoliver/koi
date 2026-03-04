import { describe, expect, mock, test } from "bun:test";
import type {
  ExternalAgentDescriptor,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
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

function createMockAdapter(instance: SandboxInstance): SandboxAdapter {
  return {
    name: "mock-adapter",
    create: mock(() => Promise.resolve(instance)),
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
    const adapter = createMockAdapter(inst);
    const spawner = createAgentSpawner({ adapter });

    const result = await spawner.spawn(stdioAgent, "fix the bug");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("fixed the bug");
    }

    await spawner.dispose();
  });

  test("missing command — returns VALIDATION error", async () => {
    const inst = createMockInstance();
    const adapter = createMockAdapter(inst);
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
    const adapter = createMockAdapter(inst);
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
    const adapter = createMockAdapter(inst);
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
    const adapter = createMockAdapter(inst);
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
    const adapter = createMockAdapter(inst);
    const spawner = createAgentSpawner({ adapter });

    const result = await spawner.spawn(stdioAgent, "task");
    expect(result.ok).toBe(true);

    await spawner.dispose();
  });

  test("semaphore limits concurrent calls", async () => {
    // let: track concurrent count
    let concurrent = 0;
    let maxConcurrent = 0;

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

    const inst: SandboxInstance = {
      exec: execMock,
      readFile: mock(() => Promise.resolve(new Uint8Array())),
      writeFile: mock(() => Promise.resolve()),
      destroy: mock(() => Promise.resolve()),
    };
    const adapter = createMockAdapter(inst);
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

  test("dispose destroys the sandbox instance", async () => {
    const inst = createMockInstance(createMockResult({ stdout: "ok" }));
    const adapter = createMockAdapter(inst);
    const spawner = createAgentSpawner({ adapter });

    // Trigger instance creation
    await spawner.spawn(stdioAgent, "init");
    await spawner.dispose();

    expect(inst.destroy).toHaveBeenCalled();
  });
});
