/**
 * Tests for `koi start` command.
 *
 * Uses mock modules to isolate from real file I/O and engine runtime.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartFlags } from "../args.js";

// ---------------------------------------------------------------------------
// Mock @koi/channel-cli to avoid stdin/stdout interaction in tests
// ---------------------------------------------------------------------------

const mockConnect = mock(() => Promise.resolve());
const mockDisconnect = mock(() => Promise.resolve());
const mockSend = mock(() => Promise.resolve());
const mockOnMessage = mock((_handler: (msg: unknown) => void | Promise<void>) => () => {});

mock.module("@koi/channel-cli", () => ({
  createCliChannel: () => ({
    name: "cli",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    },
    connect: mockConnect,
    disconnect: mockDisconnect,
    send: mockSend,
    onMessage: mockOnMessage,
  }),
}));

// ---------------------------------------------------------------------------
// Mock resolve-agent to avoid requiring real API keys in tests
// ---------------------------------------------------------------------------

const mockModelHandler = async (request: {
  readonly messages: readonly {
    readonly content: readonly { readonly kind: string; readonly text?: string }[];
  }[];
}) => {
  const inputText = request.messages
    .flatMap((m) => m.content)
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  return {
    content: `[echo] ${inputText}`,
    model: "mock-model",
    usage: { inputTokens: inputText.length, outputTokens: inputText.length + 7 },
  };
};

mock.module("../resolve-agent.js", () => ({
  resolveAgent: async () => {
    const { createLoopAdapter } = await import("@koi/engine-loop");
    return {
      ok: true,
      value: {
        middleware: [],
        model: mockModelHandler,
        engine: createLoopAdapter({ modelCall: mockModelHandler }),
      },
    };
  },
  formatResolutionError: (error: { readonly message: string }) =>
    `Resolution error: ${error.message}\n`,
}));

const { runStart } = await import("./start.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `koi-start-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

function createManifestFile(dir: string, content?: string): string {
  const manifestContent =
    content ??
    [
      "name: test-agent",
      "version: 0.1.0",
      "description: A test agent",
      "model:",
      "  name: anthropic:claude-sonnet-4-5-20250929",
    ].join("\n");

  const filePath = join(dir, "koi.yaml");
  writeFileSync(filePath, manifestContent);
  return filePath;
}

function makeFlags(overrides: Partial<StartFlags> = {}): StartFlags {
  return {
    command: "start" as const,
    directory: undefined,
    manifest: undefined,
    verbose: false,
    dryRun: false,
    nexusUrl: undefined,
    admin: false,
    temporalUrl: undefined,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  mockSend.mockClear();
  mockOnMessage.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runStart — dry-run mode", () => {
  test("loads manifest and prints info without starting the agent", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = createManifestFile(dir);

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath, dryRun: true }));
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = stderrChunks.join("");
    expect(output).toContain("Manifest: test-agent v0.1.0");
    expect(output).toContain("Model: anthropic:claude-sonnet-4-5-20250929");
    expect(output).toContain("Engine: pi");
    expect(output).toContain("Dry run complete.");

    // Should NOT connect the channel in dry-run mode
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test("accepts a directory and resolves koi.yaml within it", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    createManifestFile(dir);

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ directory: dir, manifest: undefined, dryRun: true }));
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = stderrChunks.join("");
    expect(output).toContain("Manifest: test-agent v0.1.0");
    expect(output).toContain("Dry run complete.");
  });
});

describe("runStart — manifest errors", () => {
  test("exits with error when manifest file does not exist", async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: "/nonexistent/path/koi.yaml" }));
    } catch {
      // Expected — mocked process.exit throws
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    }

    expect(exitCode).toBe(78);
    const output = stderrChunks.join("");
    expect(output).toContain("Failed to load manifest");
  });

  test("exits with error when manifest is invalid YAML", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = join(dir, "bad.yaml");
    writeFileSync(manifestPath, ": : : invalid yaml {{{}}}");

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath }));
    } catch {
      // Expected
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    }

    expect(exitCode).toBe(78);
  });
});

describe("runStart — verbose mode", () => {
  test("prints additional info in verbose dry-run", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = createManifestFile(dir);

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath, dryRun: true, verbose: true }));
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = stderrChunks.join("");
    expect(output).toContain("Manifest: test-agent v0.1.0");
  });
});

describe("runStart — default manifest path", () => {
  test("uses koi.yaml when no manifest specified", async () => {
    // This will fail to find koi.yaml in the test runner's cwd, which is expected
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags());
    } catch {
      // Expected
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    }

    // Should fail with file not found (default koi.yaml doesn't exist in test cwd)
    expect(exitCode).toBe(78);
    const output = stderrChunks.join("");
    expect(output).toContain("Failed to load manifest");
  });

  test("suggests nearby manifests when default koi.yaml is missing", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const recipeDir = join(dir, "recipes", "codex-mcp");
    mkdirSync(recipeDir, { recursive: true });
    createManifestFile(recipeDir);

    const originalCwd = process.cwd();
    process.chdir(dir);

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags());
    } catch {
      // Expected
    } finally {
      process.chdir(originalCwd);
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    }

    expect(exitCode).toBe(78);
    const output = stderrChunks.join("");
    expect(output).toContain("defaults to `./koi.yaml`");
    expect(output).toContain("koi start recipes/codex-mcp/koi.yaml");
  });
});

describe("runStart — shutdown handling", () => {
  test("sets up signal handlers and cleans up on abort", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = createManifestFile(dir);

    // Mock onMessage to trigger shutdown shortly after agent is ready
    mockOnMessage.mockImplementation((_handler: (msg: unknown) => void) => {
      // Simulate an immediate SIGINT by emitting the signal event
      setTimeout(() => {
        process.emit("SIGINT");
      }, 50);
      return () => {};
    });

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath }));
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = stderrChunks.join("");
    expect(output).toContain("Shutting down...");
    expect(output).toContain("Goodbye.");
  });
});

describe("runStart — REPL message handling", () => {
  test("processes a message through the engine and renders output", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = createManifestFile(dir);

    // Capture the message handler, send one message, then shutdown
    let capturedHandler: ((msg: unknown) => void | Promise<void>) | undefined;
    mockOnMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      capturedHandler = handler;
      // After a brief delay, send a message then trigger shutdown
      setTimeout(async () => {
        if (capturedHandler) {
          await capturedHandler({
            content: [{ kind: "text", text: "hello" }],
            senderId: "test-user",
            timestamp: Date.now(),
          });
        }
        // Shutdown after message is processed
        setTimeout(() => {
          process.emit("SIGINT");
        }, 100);
      }, 50);
      return () => {};
    });

    const stdoutChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath }));
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // The echo model should have responded with [echo] hello
    const stdoutOutput = stdoutChunks.join("");
    expect(stdoutOutput).toContain("[echo] hello");
  });

  test("renders verbose output for engine events", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = createManifestFile(dir);

    mockOnMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      setTimeout(async () => {
        await handler({
          content: [{ kind: "text", text: "test" }],
          senderId: "test-user",
          timestamp: Date.now(),
        });
        setTimeout(() => {
          process.emit("SIGINT");
        }, 100);
      }, 50);
      return () => {};
    });

    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((_chunk: string) => true) as typeof process.stdout.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath, verbose: true }));
    } finally {
      process.stderr.write = originalStderrWrite;
      process.stdout.write = originalStdoutWrite;
    }

    const output = stderrChunks.join("");
    // Verbose mode should print agent info and metrics
    expect(output).toContain("Agent: test-agent v0.1.0");
    expect(output).toContain("Engine: pi");
    expect(output).toContain("turn(s)");
    expect(output).toContain("tokens");
  });

  test("ignores empty messages", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const manifestPath = createManifestFile(dir);

    mockOnMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      setTimeout(async () => {
        // Send empty message — should be ignored
        await handler({
          content: [{ kind: "text", text: "   " }],
          senderId: "test-user",
          timestamp: Date.now(),
        });
        setTimeout(() => {
          process.emit("SIGINT");
        }, 50);
      }, 50);
      return () => {};
    });

    const stdoutChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((_chunk: string) => true) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: manifestPath }));
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // No echo output for empty message
    const stdoutOutput = stdoutChunks.join("");
    expect(stdoutOutput).not.toContain("[echo]");
  });
});

describe("runStart — manifest warnings", () => {
  test("prints warnings from manifest loading", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    // Add an unknown top-level field to trigger a warning
    const manifestContent = [
      "name: test-agent",
      "version: 0.1.0",
      "model:",
      "  name: anthropic:claude-sonnet-4-5-20250929",
      "unknownField: some-value",
    ].join("\n");
    createManifestFile(dir, manifestContent);

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await runStart(makeFlags({ manifest: join(dir, "koi.yaml"), dryRun: true }));
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = stderrChunks.join("");
    expect(output).toContain("warn:");
  });
});
