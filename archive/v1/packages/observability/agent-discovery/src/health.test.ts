import { describe, expect, it } from "bun:test";
import type { ExternalAgentDescriptor } from "@koi/core";
import { checkAgentHealth } from "./health.js";
import type { SystemCalls } from "./types.js";

const cliAgent: ExternalAgentDescriptor = {
  name: "test-agent",
  transport: "cli",
  command: "test-cmd",
  capabilities: ["code-generation"],
  source: "path",
};

const mcpAgent: ExternalAgentDescriptor = {
  name: "mcp-agent",
  transport: "mcp",
  capabilities: ["code-review"],
  source: "mcp",
};

function createMockSystemCalls(exitCode: number, stdout: string): SystemCalls {
  return {
    which: () => null,
    exec: async () => ({ exitCode, stdout }),
  };
}

function createThrowingSystemCalls(error: Error): SystemCalls {
  return {
    which: () => null,
    exec: async () => {
      throw error;
    },
  };
}

describe("checkAgentHealth", () => {
  it("returns healthy for CLI agent with exit code 0", async () => {
    const sys = createMockSystemCalls(0, "1.2.3");
    const result = await checkAgentHealth(cliAgent, sys);

    expect(result.status).toBe("healthy");
    expect(result.message).toBe("1.2.3");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns unhealthy for CLI agent with non-zero exit code", async () => {
    const sys = createMockSystemCalls(1, "");
    const result = await checkAgentHealth(cliAgent, sys);

    expect(result.status).toBe("unhealthy");
    expect(result.message).toContain("Exit code: 1");
  });

  it("returns unhealthy when exec throws", async () => {
    const sys = createThrowingSystemCalls(new Error("Command timed out"));
    const result = await checkAgentHealth(cliAgent, sys);

    expect(result.status).toBe("unhealthy");
    expect(result.message).toContain("Command timed out");
  });

  it("returns unknown for non-CLI transport", async () => {
    const sys = createMockSystemCalls(0, "");
    const result = await checkAgentHealth(mcpAgent, sys);

    expect(result.status).toBe("unknown");
    expect(result.latencyMs).toBe(0);
  });

  it("returns unknown for CLI agent without command", async () => {
    const noCmd: ExternalAgentDescriptor = {
      ...cliAgent,
      command: undefined,
    };
    const sys = createMockSystemCalls(0, "");
    const result = await checkAgentHealth(noCmd, sys);

    expect(result.status).toBe("unknown");
  });
});
