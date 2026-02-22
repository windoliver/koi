import { describe, expect, it } from "bun:test";
import { createShellTool } from "./shell.js";

describe("shell tool", () => {
  it("has correct descriptor", () => {
    const tool = createShellTool();
    expect(tool.descriptor.name).toBe("shell");
    expect(tool.trustTier).toBe("sandbox");
  });

  it("executes a simple command", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "echo hello" })) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "echo error >&2" })) as {
      stderr: string;
      exitCode: number;
    };
    expect(result.stderr.trim()).toBe("error");
  });

  it("returns non-zero exit code", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "exit 42" })) as { exitCode: number };
    expect(result.exitCode).toBe(42);
  });

  it("times out long commands", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({
      command: "sleep 10",
      timeoutMs: 100,
    })) as { error: string; timedOut: boolean };
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  it("rejects empty command", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "" })) as { error: string };
    expect(result.error).toContain("non-empty string");
  });

  it("rejects missing command", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({})) as { error: string };
    expect(result.error).toContain("non-empty string");
  });

  it("respects custom cwd", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "pwd", cwd: "/tmp" })) as {
      stdout: string;
    };
    expect(result.stdout.trim()).toContain("tmp");
  });
});
