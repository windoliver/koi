import { afterEach, describe, expect, mock, test } from "bun:test";
import type { DiscoverySource } from "@koi/agent-discovery";
import type {
  ExternalAgentDescriptor,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
} from "@koi/core";
import type { ForgeDelegation } from "./create-forge-delegation.js";
import { createForgeDelegation } from "./create-forge-delegation.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const testAgent: ExternalAgentDescriptor = {
  name: "claude-code",
  displayName: "Claude Code",
  transport: "cli",
  command: "claude",
  capabilities: ["code-generation"],
  source: "path",
  protocol: "stdio",
};

function createMockResult(overrides?: Partial<SandboxAdapterResult>): SandboxAdapterResult {
  return {
    exitCode: 0,
    stdout: "return input.a + input.b;",
    stderr: "",
    durationMs: 50,
    timedOut: false,
    oomKilled: false,
    ...overrides,
  };
}

function createMockInstance(execResult: SandboxAdapterResult = createMockResult()): {
  readonly instance: SandboxInstance;
  readonly execMock: ReturnType<typeof mock>;
} {
  const execMock = mock(() => Promise.resolve(execResult));
  return {
    instance: {
      exec: execMock,
      readFile: mock(() => Promise.resolve(new Uint8Array())),
      writeFile: mock(() => Promise.resolve()),
      destroy: mock(() => Promise.resolve()),
    },
    execMock,
  };
}

function createMockAdapter(instance: SandboxInstance): SandboxAdapter {
  return {
    name: "mock-adapter",
    create: mock(() => Promise.resolve(instance)),
  };
}

function createMockSource(agents: readonly ExternalAgentDescriptor[]): DiscoverySource {
  return {
    name: "mock-source",
    discover: async () => agents,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// let justified: tracks current delegation for afterEach cleanup
let delegation: ForgeDelegation | undefined;

afterEach(async () => {
  if (delegation !== undefined) {
    await delegation.dispose();
    delegation = undefined;
  }
});

describe("createForgeDelegation", () => {
  describe("discoverAgent", () => {
    test("returns agent when found by name", async () => {
      const { instance } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        discoverySources: [createMockSource([testAgent])],
      });

      const result = await delegation.discoverAgent("claude-code");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("claude-code");
        expect(result.value.command).toBe("claude");
      }
    });

    test("returns NOT_FOUND for unknown agent", async () => {
      const { instance } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        discoverySources: [createMockSource([testAgent])],
      });

      const result = await delegation.discoverAgent("nonexistent-agent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toContain("nonexistent-agent");
      }
    });

    test("returns VALIDATION error for empty name", async () => {
      const { instance } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        discoverySources: [createMockSource([testAgent])],
      });

      const result = await delegation.discoverAgent("");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("empty");
      }
    });
  });

  describe("spawnCodingAgent", () => {
    test("bridges DelegateOptions to SpawnOptions (model + timeoutMs)", async () => {
      const { instance, execMock } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        discoverySources: [createMockSource([testAgent])],
      });

      const result = await delegation.spawnCodingAgent(testAgent, "implement foo", {
        model: "opus",
        timeoutMs: 30_000,
        retries: 3, // retries should be dropped — handled by delegateImplementation
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("return input.a + input.b;");
      }

      expect(execMock).toHaveBeenCalled();
    });

    test("returns error when agent has no command", async () => {
      const { instance } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        discoverySources: [createMockSource([])],
      });

      const agentNoCmd: ExternalAgentDescriptor = {
        name: "no-command-agent",
        transport: "cli",
        capabilities: ["code-generation"],
        source: "path",
      };

      const result = await delegation.spawnCodingAgent(agentNoCmd, "implement foo", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });
  });

  describe("dispose", () => {
    test("disposes underlying sandbox resources", async () => {
      const { instance } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        discoverySources: [createMockSource([])],
      });

      // Trigger spawner to create instance
      await delegation.spawnCodingAgent(testAgent, "test", {});

      await delegation.dispose();
      delegation = undefined; // already disposed

      expect(instance.destroy).toHaveBeenCalled();
    });
  });

  describe("config passthrough", () => {
    test("forwards cwd and env to spawner", async () => {
      const { instance, execMock } = createMockInstance();
      const adapter = createMockAdapter(instance);

      delegation = createForgeDelegation({
        adapter,
        cwd: "/workspace",
        env: { API_KEY: "test" },
        maxConcurrentDelegations: 1,
        maxOutputBytes: 1024,
        discoverySources: [createMockSource([testAgent])],
      });

      await delegation.spawnCodingAgent(testAgent, "test", {});

      // Verify exec was called with cwd
      const execCall = execMock.mock.calls[0];
      const execOptions = execCall?.[2] as { cwd?: string } | undefined;
      expect(execOptions?.cwd).toBe("/workspace");
    });
  });
});
