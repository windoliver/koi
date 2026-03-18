/**
 * Tests for the CLI channel adapter.
 *
 * Uses PassThrough streams as mock stdin/stdout/stderr to verify
 * behavior without actual terminal I/O.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { CliCommandDeps } from "@koi/cli-commands";
import type { InboundMessage, OutboundMessage } from "@koi/core";
import { testChannelAdapter } from "@koi/test-utils";
import { createCliChannel } from "./cli-channel.js";

/**
 * Creates a set of mock streams for testing.
 */
function createMockStreams(): {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly errorOutput: PassThrough;
} {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    errorOutput: new PassThrough(),
  };
}

/**
 * Reads all buffered data from a PassThrough stream as a string.
 */
function readStream(stream: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null = stream.read() as Buffer | null;
  while (chunk !== null) {
    chunks.push(chunk);
    chunk = stream.read() as Buffer | null;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Track streams to clean up after each test
let activeStreams: PassThrough[] = [];

afterEach(async () => {
  for (const stream of activeStreams) {
    stream.destroy();
  }
  activeStreams = [];
  // Let Bun's internal readline/stream cleanup settle before next test.
  // Prevents stochastic DOMException: TimeoutError during parallel execution.
  await Bun.sleep(10);
});

describe("createCliChannel", () => {
  // Run the contract test suite from @koi/test-utils
  describe("contract compliance", () => {
    // Capture the latest streams so injectMessage can write to stdin.
    // createAdapter() runs before injectMessage() in each test, so this is safe.
    let contractStreams: ReturnType<typeof createMockStreams> | undefined;

    testChannelAdapter({
      createAdapter: () => {
        const streams = createMockStreams();
        contractStreams = streams;
        activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
        return createCliChannel({
          input: streams.input,
          output: streams.output,
          errorOutput: streams.errorOutput,
        });
      },
      injectMessage: async (_adapter) => {
        contractStreams?.input.write("contract-inject\n");
        await Bun.sleep(50);
      },
    });
  });

  test("name is 'cli'", () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    expect(channel.name).toBe("cli");
  });

  test("capabilities reports text only", () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    expect(channel.capabilities).toEqual({
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    });
  });

  test("connect and disconnect lifecycle", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    await channel.connect();
    await channel.disconnect();
    // Should not throw on second disconnect
    await channel.disconnect();
  });

  test("disconnect without connect does not throw", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    await channel.disconnect();
  });

  test("send writes text blocks to output stream", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    await channel.connect();

    const message: OutboundMessage = {
      content: [
        { kind: "text", text: "Hello, world!" },
        { kind: "text", text: "Second line" },
      ],
    };
    await channel.send(message);

    const written = readStream(streams.output);
    expect(written).toContain("Hello, world!\n");
    expect(written).toContain("Second line\n");

    await channel.disconnect();
  });

  test("send: image/file/button blocks are downgraded to text on stdout; custom goes to stderr", async () => {
    // Behavior note: image, file, and button are downgraded to TextBlock by
    // renderBlocks() (CLI declares these capabilities false) and written to stdout.
    // CustomBlock has no capability flag, passes through to stderr.
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    await channel.connect();

    const message: OutboundMessage = {
      content: [
        {
          kind: "file",
          url: "https://example.com/doc.pdf",
          mimeType: "application/pdf",
          name: "doc.pdf",
        },
        { kind: "image", url: "https://example.com/pic.png", alt: "A picture" },
        { kind: "button", label: "Click me", action: "click" },
        { kind: "custom", type: "chart", data: { x: 1 } },
      ],
    };
    await channel.send(message);

    // Downgraded blocks written to stdout (consistent with text output)
    const textWritten = readStream(streams.output);
    expect(textWritten).toContain("[File: doc.pdf]");
    expect(textWritten).toContain("[Image: A picture]");
    expect(textWritten).toContain("[Click me]");

    // Custom block (no capability flag) still goes to stderr
    const errorWritten = readStream(streams.errorOutput);
    expect(errorWritten).toContain("[custom: chart]");
    expect(errorWritten).not.toContain("[File:");
    expect(errorWritten).not.toContain("[Image:");

    await channel.disconnect();
  });

  test("send before connect throws — channel is not connected", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const message: OutboundMessage = {
      content: [{ kind: "text", text: "Before connect" }],
    };
    await expect(channel.send(message)).rejects.toThrow("is not connected");
  });

  test("send with empty content does not write anything", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    await channel.connect();

    const message: OutboundMessage = { content: [] };
    await channel.send(message);

    // Read what's on output after the prompt from connect
    const written = readStream(streams.output);
    // Only the prompt should be there, no extra newlines from send
    expect(written).not.toContain("\n\n");

    await channel.disconnect();
  });

  test("onMessage delivers user input to handler", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      senderId: "test-user",
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();

    // Simulate user typing a line
    streams.input.write("hello\n");

    // Give the event loop a tick to process
    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(received[0]?.senderId).toBe("test-user");
    expect(typeof received[0]?.timestamp).toBe("number");

    await channel.disconnect();
  });

  test("multiple handlers receive the same message", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const received1: InboundMessage[] = [];
    const received2: InboundMessage[] = [];

    channel.onMessage(async (msg) => {
      received1.push(msg);
    });
    channel.onMessage(async (msg) => {
      received2.push(msg);
    });

    await channel.connect();

    streams.input.write("multi\n");
    await Bun.sleep(50);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]?.content).toEqual(received2[0]?.content);

    await channel.disconnect();
  });

  test("onMessage returns unsubscribe function", () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const handler = async (_msg: InboundMessage): Promise<void> => {};
    const unsubscribe = channel.onMessage(handler);
    expect(typeof unsubscribe).toBe("function");
  });

  test("unsubscribe stops handler from receiving messages", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const received: InboundMessage[] = [];
    const unsubscribe = channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();

    // Send a message, handler should receive it
    streams.input.write("before\n");
    await Bun.sleep(50);
    expect(received).toHaveLength(1);

    // Unsubscribe
    unsubscribe();

    // Send another message, handler should NOT receive it
    streams.input.write("after\n");
    await Bun.sleep(50);
    expect(received).toHaveLength(1);

    await channel.disconnect();
  });

  test("unsubscribe is idempotent", () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const handler = async (_msg: InboundMessage): Promise<void> => {};
    const unsubscribe = channel.onMessage(handler);
    unsubscribe();
    // Should not throw on second call
    unsubscribe();
  });

  test("file block without name falls back to URL in downgraded text on stdout", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    await channel.connect();
    const message: OutboundMessage = {
      content: [{ kind: "file", url: "https://example.com/doc.pdf", mimeType: "application/pdf" }],
    };
    await channel.send(message);
    await channel.disconnect();

    const textWritten = readStream(streams.output);
    expect(textWritten).toContain("[File: https://example.com/doc.pdf]");
  });

  test("image block without alt falls back to URL in downgraded text on stdout", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    await channel.connect();
    const message: OutboundMessage = {
      content: [{ kind: "image", url: "https://example.com/pic.png" }],
    };
    await channel.send(message);
    await channel.disconnect();

    const textWritten = readStream(streams.output);
    expect(textWritten).toContain("[Image: https://example.com/pic.png]");
  });

  test("custom prompt is used", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      prompt: "koi> ",
    });

    await channel.connect();

    const written = readStream(streams.output);
    expect(written).toContain("koi> ");

    await channel.disconnect();
  });

  test("dark theme uses colored koi> prompt", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      theme: "dark",
    });

    await channel.connect();

    const written = readStream(streams.output);
    expect(written).toContain("koi>");

    await channel.disconnect();
  });

  test("light theme uses colored koi> prompt", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      theme: "light",
    });

    await channel.connect();

    const written = readStream(streams.output);
    expect(written).toContain("koi>");

    await channel.disconnect();
  });

  test("mono theme uses plain prompt", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      theme: "mono",
    });

    await channel.connect();

    const written = readStream(streams.output);
    expect(written).toContain("> ");
    // Mono should not contain ANSI escape codes in prompt
    expect(written).not.toContain("\x1b[36m");

    await channel.disconnect();
  });

  test("prompt override takes precedence over theme default", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      theme: "dark",
      prompt: "custom> ",
    });

    await channel.connect();

    const written = readStream(streams.output);
    expect(written).toContain("custom> ");

    await channel.disconnect();
  });

  test("does not implement sendStatus (backward-compatible)", () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    expect(channel.sendStatus).toBeUndefined();
  });

  test("handler that throws does not prevent other handlers from receiving the message", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const received: InboundMessage[] = [];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    channel.onMessage(async () => {
      throw new Error("handler crash");
    });
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    streams.input.write("hello\n");
    await Bun.sleep(50);

    expect(received).toHaveLength(1); // second handler still received the message
    // Error written to errorOutput by onHandlerError
    const errorWritten = readStream(streams.errorOutput);
    expect(errorWritten).toContain("handler crash");

    await channel.disconnect();
  });

  test("reconnect cycle: handlers registered before disconnect receive messages after reconnect", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    streams.input.write("first\n");
    await Bun.sleep(50);
    expect(received).toHaveLength(1);

    await channel.disconnect();

    // Reconnect — must create fresh streams since readline closes the old ones
    const streams2 = createMockStreams();
    activeStreams = [...activeStreams, streams2.input, streams2.output, streams2.errorOutput];
    const channel2 = createCliChannel({
      input: streams2.input,
      output: streams2.output,
      errorOutput: streams2.errorOutput,
    });
    channel2.onMessage(async (msg) => {
      received.push(msg);
    });
    await channel2.connect();
    streams2.input.write("second\n");
    await Bun.sleep(50);

    expect(received).toHaveLength(2); // both messages received
    await channel2.disconnect();
  });

  test("connect is idempotent", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    await channel.connect();
    await channel.connect(); // Should not throw or create duplicate readline interfaces

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    streams.input.write("test\n");
    await Bun.sleep(50);

    // Should only receive one message, not duplicated
    expect(received).toHaveLength(1);

    await channel.disconnect();
  });
});

// ─── Slash Command Interception ─────────────────────────────────────

function createMockCommandDeps(
  overrides: Partial<CliCommandDeps> = {},
): CliCommandDeps & { readonly written: () => string } {
  const depOutput = new PassThrough();
  return {
    cancelStream: mock(() => {}),
    listModels: mock(() => ["claude-sonnet-4-6"]),
    currentModel: mock(() => "claude-sonnet-4-6"),
    setModel: mock(() => ({ ok: true })),
    output: depOutput,
    exit: mock(() => {}),
    written() {
      const chunks: Buffer[] = [];
      let chunk: Buffer | null = depOutput.read() as Buffer | null;
      while (chunk !== null) {
        chunks.push(chunk);
        chunk = depOutput.read() as Buffer | null;
      }
      return Buffer.concat(chunks).toString("utf-8");
    },
    ...overrides,
  };
}

describe("slash command interception", () => {
  test("slash command is intercepted and not forwarded to message handler", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandDeps = createMockCommandDeps({ output: streams.output });
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandDeps,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    streams.input.write("/help\n");
    await Bun.sleep(100);

    // /help should NOT be forwarded as a message
    expect(received).toHaveLength(0);

    await channel.disconnect();
  });

  test("non-slash lines are forwarded as messages when commandDeps provided", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandDeps = createMockCommandDeps({ output: streams.output });
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandDeps,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    streams.input.write("hello world\n");
    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([{ kind: "text", text: "hello world" }]);

    await channel.disconnect();
  });

  test("unknown slash command writes error to output", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandDeps = createMockCommandDeps({ output: streams.output });
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandDeps,
    });

    channel.onMessage(async () => {});
    await channel.connect();

    streams.input.write("/foobar\n");
    await Bun.sleep(100);

    const written = readStream(streams.output);
    expect(written).toContain("Unknown command");

    await channel.disconnect();
  });

  test("slash interception disabled when no commandDeps provided", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    // No commandDeps — slash lines should be forwarded as messages
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    streams.input.write("/help\n");
    await Bun.sleep(50);

    // Without commandDeps, /help is treated as a regular message
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([{ kind: "text", text: "/help" }]);

    await channel.disconnect();
  });

  test("/cancel calls cancelStream on commandDeps", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandDeps = createMockCommandDeps({ output: streams.output });
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandDeps,
    });

    channel.onMessage(async () => {});
    await channel.connect();

    streams.input.write("/cancel\n");
    await Bun.sleep(100);

    expect(commandDeps.cancelStream).toHaveBeenCalledTimes(1);

    await channel.disconnect();
  });

  test("TUI-only command shows redirect message", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandDeps = createMockCommandDeps({ output: streams.output });
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandDeps,
    });

    channel.onMessage(async () => {});
    await channel.connect();

    streams.input.write("/agents\n");
    await Bun.sleep(100);

    const written = readStream(streams.output);
    expect(written).toContain("TUI panel command");
    expect(written).toContain("koi tui");

    await channel.disconnect();
  });
});
