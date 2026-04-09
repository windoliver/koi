import { describe, expect, test } from "bun:test";
import type { ResolvedLspServerConfig } from "./config.js";
import { createStdioTransport } from "./transport.js";

const BASE_CONFIG: ResolvedLspServerConfig = {
  name: "test",
  command: "cat",
  args: [],
  env: {},
  rootUri: "file:///tmp",
  languageId: undefined,
  initializationOptions: undefined,
  timeoutMs: 30_000,
};

describe("createStdioTransport", () => {
  test("spawns a process and provides Bun-native streams", () => {
    const transport = createStdioTransport(BASE_CONFIG);

    // stdin is a Bun FileSink
    expect(transport.stdin).toBeDefined();
    expect(typeof transport.stdin.write).toBe("function");
    expect(typeof transport.stdin.flush).toBe("function");

    // stdout is a WHATWG ReadableStream
    expect(transport.stdout).toBeDefined();
    expect(typeof transport.stdout.getReader).toBe("function");

    // exited is a Promise
    expect(transport.exited).toBeInstanceOf(Promise);

    transport.dispose();
  });

  test("dispose kills the process and exited resolves", async () => {
    const transport = createStdioTransport({
      ...BASE_CONFIG,
      command: "sleep",
      args: ["60"],
    });

    // exited promise should not have resolved yet
    let resolved = false;
    void transport.exited.then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    transport.dispose();

    // After dispose, exited should resolve (process killed)
    await transport.exited;
    expect(resolved).toBe(true);
  });

  test("exited resolves with exit code for short-lived process", async () => {
    const transport = createStdioTransport({
      ...BASE_CONFIG,
      command: "true",
      args: [],
    });

    const code = await transport.exited;
    expect(typeof code).toBe("number");
  });
});
