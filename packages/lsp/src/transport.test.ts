import { describe, expect, test } from "bun:test";
import type { ResolvedLspServerConfig } from "./config.js";
import { createStdioTransport } from "./transport.js";

// ---------------------------------------------------------------------------
// createStdioTransport
// ---------------------------------------------------------------------------

describe("createStdioTransport", () => {
  test("spawns a process and provides stdio streams", () => {
    const config: ResolvedLspServerConfig = {
      name: "echo-test",
      command: "cat",
      args: [],
      env: {},
      rootUri: "file:///tmp",
      languageId: undefined,
      initializationOptions: undefined,
      timeoutMs: 30_000,
    };

    const transport = createStdioTransport(config);

    expect(transport.stdin).toBeDefined();
    expect(transport.stdout).toBeDefined();
    expect(transport.process).toBeDefined();
    expect(transport.process.pid).toBeGreaterThan(0);

    transport.dispose();
  });

  test("dispose kills the process", () => {
    const config: ResolvedLspServerConfig = {
      name: "sleep-test",
      command: "sleep",
      args: ["60"],
      env: {},
      rootUri: "file:///tmp",
      languageId: undefined,
      initializationOptions: undefined,
      timeoutMs: 30_000,
    };

    const transport = createStdioTransport(config);
    const pid = transport.process.pid;
    expect(pid).toBeGreaterThan(0);

    transport.dispose();
    expect(transport.process.killed).toBe(true);
  });

  test("emits error event for nonexistent command", async () => {
    const config: ResolvedLspServerConfig = {
      name: "bad-cmd",
      command: "nonexistent-binary-xyz-12345",
      args: [],
      env: {},
      rootUri: "file:///tmp",
      languageId: undefined,
      initializationOptions: undefined,
      timeoutMs: 30_000,
    };

    const transport = createStdioTransport(config);

    // In Bun/Node, spawn with a missing binary emits 'error' asynchronously
    const error = await new Promise<Error>((resolve) => {
      transport.process.on("error", (err: Error) => resolve(err));
    });

    expect(error.message).toContain("nonexistent-binary-xyz-12345");
    transport.dispose();
  });
});
