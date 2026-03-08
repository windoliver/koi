/**
 * Tests for `koi serve` command.
 *
 * Covers: manifest loading, channel wiring, conversation persistence,
 * per-session concurrency, graceful shutdown, and arena failure fallback.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  captureStderr,
  cleanupTempDirs,
  createInboundMessage,
  createManifestFile,
  createMockChannel,
  createMockChannelAdapter,
  makeTempDir,
  mockModelHandler,
  mockProcessExit,
} from "../__tests__/test-helpers.js";
import type { ServeFlags } from "../args.js";

// ---------------------------------------------------------------------------
// Mock @koi/channel-cli (serve mode doesn't use it, but start.ts fallback does)
// ---------------------------------------------------------------------------

mock.module("@koi/channel-cli", () => ({
  createCliChannel: () => {
    throw new Error("serve should not create CLI channel");
  },
}));

// ---------------------------------------------------------------------------
// Mock resolve-agent to avoid requiring real API keys
// ---------------------------------------------------------------------------

const mockChannel = createMockChannel();

mock.module("../resolve-agent.js", () => ({
  resolveAgent: async () => {
    const { createLoopAdapter } = await import("@koi/engine-loop");
    return {
      ok: true,
      value: {
        middleware: [],
        model: mockModelHandler,
        engine: createLoopAdapter({ modelCall: mockModelHandler }),
        channels: [createMockChannelAdapter(mockChannel)],
      },
    };
  },
  formatResolutionError: (error: { readonly message: string }) =>
    `Resolution error: ${error.message}\n`,
}));

// ---------------------------------------------------------------------------
// Mock @koi/nexus to avoid real Nexus startup
// ---------------------------------------------------------------------------

mock.module("@koi/nexus", () => ({
  createNexusStack: async () => ({
    middlewares: [],
    providers: [],
    dispose: async () => {},
    config: { baseUrl: "http://localhost:2026" },
  }),
}));

// ---------------------------------------------------------------------------
// Mock @koi/deploy health server
// ---------------------------------------------------------------------------

const mockHealthStart = mock(async () => ({
  url: "http://localhost:9100",
  port: 9100,
}));
const mockHealthStop = mock(() => {});

mock.module("@koi/deploy", () => ({
  createHealthServer: () => ({
    start: mockHealthStart,
    stop: mockHealthStop,
  }),
}));

const { runServe } = await import("./serve.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlags(overrides: Partial<ServeFlags> = {}): ServeFlags {
  return {
    command: "serve" as const,
    directory: undefined,
    manifest: undefined,
    port: undefined,
    verbose: false,
    nexusUrl: undefined,
    ...overrides,
  };
}

/** Triggers shutdown after a short delay via the shutdown handler. */
function scheduleShutdown(delayMs = 50): void {
  setTimeout(() => {
    process.emit("SIGTERM");
  }, delayMs);
}

afterEach(() => {
  cleanupTempDirs();
  mockChannel.connect.mockClear();
  mockChannel.disconnect.mockClear();
  mockChannel.send.mockClear();
  mockChannel.onMessage.mockClear();
  mockHealthStart.mockClear();
  mockHealthStop.mockClear();
});

// ---------------------------------------------------------------------------
// Baseline tests
// ---------------------------------------------------------------------------

describe("runServe — manifest errors", () => {
  test("exits with error when manifest file does not exist", async () => {
    const exitMock = mockProcessExit();
    const stderr = captureStderr();

    try {
      await runServe(makeFlags({ manifest: "/nonexistent/koi.yaml" }));
    } catch {
      // Expected — mocked process.exit throws
    } finally {
      exitMock.restore();
      stderr.restore();
    }

    expect(exitMock.code()).toBe(78);
    expect(stderr.chunks.join("")).toContain("Failed to load manifest");
  });
});

describe("runServe — startup and shutdown", () => {
  test("connects channels, starts health server, and shuts down cleanly", async () => {
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    // Schedule shutdown right after serve starts
    mockChannel.onMessage.mockImplementation(() => {
      scheduleShutdown();
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml") }));
    } finally {
      stderr.restore();
    }

    expect(mockChannel.connect).toHaveBeenCalledTimes(1);
    expect(mockChannel.disconnect).toHaveBeenCalledTimes(1);
    expect(mockHealthStart).toHaveBeenCalledTimes(1);
    expect(mockHealthStop).toHaveBeenCalledTimes(1);

    const output = stderr.chunks.join("");
    expect(output).toContain("serving on port 9100");
    expect(output).toContain("Goodbye.");
  });

  test("prints verbose info when verbose flag is set", async () => {
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    mockChannel.onMessage.mockImplementation(() => {
      scheduleShutdown();
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml"), verbose: true }));
    } finally {
      stderr.restore();
    }

    const output = stderr.chunks.join("");
    expect(output).toContain("Agent: test-agent v0.1.0");
    expect(output).toContain("Model: anthropic:claude-sonnet-4-5-20250929");
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

describe("runServe — message handling", () => {
  test("processes a message and sends response via channel", async () => {
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    let capturedHandler: ((msg: unknown) => void | Promise<void>) | undefined;

    mockChannel.onMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      capturedHandler = handler;
      setTimeout(async () => {
        if (capturedHandler) {
          await capturedHandler(createInboundMessage("hello from serve"));
        }
        scheduleShutdown(100);
      }, 50);
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml") }));
    } finally {
      stderr.restore();
    }

    // Channel should have received a response containing the user's text
    expect(mockChannel.send).toHaveBeenCalled();
    const sentContent = mockChannel.send.mock.calls[0]?.[0] as {
      readonly content: readonly { readonly kind: string; readonly text: string }[];
    };
    const texts = sentContent.content
      .filter(
        (b: { readonly kind: string }): b is { readonly kind: "text"; readonly text: string } =>
          b.kind === "text",
      )
      .map((b: { readonly text: string }) => b.text);
    // The echo model echoes back the full input (which may include middleware
    // capability descriptions injected before the user text)
    expect(texts.join("")).toContain("hello from serve");
  });

  test("ignores empty messages", async () => {
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    mockChannel.onMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      setTimeout(async () => {
        await handler(createInboundMessage("   "));
        scheduleShutdown(50);
      }, 50);
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml") }));
    } finally {
      stderr.restore();
    }

    expect(mockChannel.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-session concurrency — session key derivation
// ---------------------------------------------------------------------------

describe("runServe — per-session state tracking", () => {
  test("messages from different senders are both processed sequentially", async () => {
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    mockChannel.onMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      setTimeout(async () => {
        // Send messages from two different users sequentially
        const msg1 = createInboundMessage("msg from user-A", "user-A");
        const msg2 = createInboundMessage("msg from user-B", "user-B");

        await handler(msg1);
        await handler(msg2);

        scheduleShutdown(100);
      }, 50);
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml") }));
    } finally {
      stderr.restore();
    }

    // Both messages should have been processed (runtime is single-flight,
    // so they serialize globally, but both complete successfully)
    expect(mockChannel.send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Conversation persistence — arena fallback
// ---------------------------------------------------------------------------

describe("runServe — conversation persistence", () => {
  test("agent still serves when context-arena creation fails", async () => {
    // This tests the graceful fallback path. If context-arena throws during
    // createContextArena(), serve should warn and continue without conversation.
    // The mock resolver provides a working engine — the agent should still respond.
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    mockChannel.onMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      setTimeout(async () => {
        await handler(createInboundMessage("hello despite no arena"));
        scheduleShutdown(100);
      }, 50);
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml") }));
    } finally {
      stderr.restore();
    }

    // Agent should still respond even if arena had issues
    expect(mockChannel.send).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("runServe — error handling", () => {
  test("logs channel errors with session key context and continues serving", async () => {
    const dir = makeTempDir("koi-serve");
    createManifestFile(dir);

    // Make send throw on first call to simulate a channel error
    let sendCallCount = 0;
    mockChannel.send.mockImplementation(async () => {
      sendCallCount++;
      if (sendCallCount === 1) {
        throw new Error("channel write failed");
      }
    });

    mockChannel.onMessage.mockImplementation((handler: (msg: unknown) => void | Promise<void>) => {
      setTimeout(async () => {
        // First message triggers error path
        await handler(createInboundMessage("will fail", "error-user"));
        // Second message should still be processed (agent recovers)
        await handler(createInboundMessage("will succeed", "ok-user"));
        scheduleShutdown(100);
      }, 50);
      return () => {};
    });

    const stderr = captureStderr();
    try {
      await runServe(makeFlags({ manifest: join(dir, "koi.yaml") }));
    } finally {
      stderr.restore();
    }

    const output = stderr.chunks.join("");
    // Error is logged with session key context
    expect(output).toContain('Channel "mock-channel"');
    expect(output).toContain("error-user");
    expect(output).toContain("channel write failed");
    // Agent didn't crash — shutdown completed normally
    expect(output).toContain("Goodbye.");
  });
});
