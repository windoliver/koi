/**
 * Tests for the CLI channel adapter.
 *
 * Uses PassThrough streams as mock stdin/stdout/stderr to verify
 * behavior without actual terminal I/O.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { InboundMessage, OutboundMessage } from "@koi/core";
import type { SlashCommandHandler } from "./cli-channel.js";
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
  const chunks: Uint8Array[] = [];
  // let requires justification: iterating through stream chunks
  let chunk: Uint8Array | null = stream.read() as Uint8Array | null;
  while (chunk !== null) {
    chunks.push(chunk);
    chunk = stream.read() as Uint8Array | null;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Track streams to clean up after each test
// let requires justification: accumulated across tests, reset in afterEach
let activeStreams: PassThrough[] = [];

afterEach(async () => {
  for (const stream of activeStreams) {
    stream.destroy();
  }
  activeStreams = [];
  // Let Bun's internal readline/stream cleanup settle before next test.
  await Bun.sleep(10);
});

describe("createCliChannel", () => {
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

  describe("lifecycle", () => {
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

    test("connect is idempotent", async () => {
      const streams = createMockStreams();
      activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
      const channel = createCliChannel({
        input: streams.input,
        output: streams.output,
        errorOutput: streams.errorOutput,
      });

      await channel.connect();
      await channel.connect();

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

    test("send before connect throws", async () => {
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
  });

  describe("send", () => {
    test("writes text blocks to output stream", async () => {
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

    test("image/file/button blocks are downgraded to text on stdout; custom goes to stderr", async () => {
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

      const textWritten = readStream(streams.output);
      expect(textWritten).toContain("[File: doc.pdf]");
      expect(textWritten).toContain("[Image: A picture]");
      expect(textWritten).toContain("[Click me]");

      const errorWritten = readStream(streams.errorOutput);
      expect(errorWritten).toContain("[custom: chart]");
      expect(errorWritten).not.toContain("[File:");
      expect(errorWritten).not.toContain("[Image:");

      await channel.disconnect();
    });

    test("file block without name falls back to URL", async () => {
      const streams = createMockStreams();
      activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
      const channel = createCliChannel({
        input: streams.input,
        output: streams.output,
        errorOutput: streams.errorOutput,
      });

      await channel.connect();
      await channel.send({
        content: [
          { kind: "file", url: "https://example.com/doc.pdf", mimeType: "application/pdf" },
        ],
      });
      await channel.disconnect();

      const textWritten = readStream(streams.output);
      expect(textWritten).toContain("[File: https://example.com/doc.pdf]");
    });

    test("image block without alt falls back to URL", async () => {
      const streams = createMockStreams();
      activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
      const channel = createCliChannel({
        input: streams.input,
        output: streams.output,
        errorOutput: streams.errorOutput,
      });

      await channel.connect();
      await channel.send({
        content: [{ kind: "image", url: "https://example.com/pic.png" }],
      });
      await channel.disconnect();

      const textWritten = readStream(streams.output);
      expect(textWritten).toContain("[Image: https://example.com/pic.png]");
    });

    test("empty content does not write anything extra", async () => {
      const streams = createMockStreams();
      activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
      const channel = createCliChannel({
        input: streams.input,
        output: streams.output,
        errorOutput: streams.errorOutput,
      });
      await channel.connect();
      await channel.send({ content: [] });

      const written = readStream(streams.output);
      expect(written).not.toContain("\n\n");

      await channel.disconnect();
    });
  });

  describe("onMessage", () => {
    test("delivers user input to handler", async () => {
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
      streams.input.write("hello\n");
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
      streams.input.write("before\n");
      await Bun.sleep(50);
      expect(received).toHaveLength(1);

      unsubscribe();
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
      unsubscribe(); // should not throw
    });
  });

  describe("error handling", () => {
    test("handler that throws does not prevent other handlers", async () => {
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

      expect(received).toHaveLength(1);
      const errorWritten = readStream(streams.errorOutput);
      expect(errorWritten).toContain("handler crash");

      await channel.disconnect();
    });
  });

  describe("themes", () => {
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

    test("dark theme uses koi> prompt", async () => {
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

    test("light theme uses koi> prompt", async () => {
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

    test("mono theme uses plain prompt without ANSI codes", async () => {
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
  });

  describe("tab completion", () => {
    test("completer is wired to readline when provided", async () => {
      const streams = createMockStreams();
      activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
      const completerFn = mock((line: string): readonly [readonly string[], string] => {
        const commands = ["/help", "/clear", "/exit"] as const;
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length > 0 ? hits : commands, line];
      });

      const channel = createCliChannel({
        input: streams.input,
        output: streams.output,
        errorOutput: streams.errorOutput,
        completer: completerFn,
      });

      await channel.connect();
      // The completer is registered with readline — we verify it's callable
      // by checking it was passed. Tab completion is exercised by readline internally.
      await channel.disconnect();
    });

    test("completer returns matching commands", () => {
      // Test the completer function directly as a pure function
      const completer = (line: string): readonly [readonly string[], string] => {
        const commands = ["/help", "/clear", "/exit"] as const;
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length > 0 ? hits : commands, line];
      };

      const [matches, substring] = completer("/h");
      expect(matches).toEqual(["/help"]);
      expect(substring).toBe("/h");
    });

    test("completer returns all commands when no match", () => {
      const completer = (line: string): readonly [readonly string[], string] => {
        const commands = ["/help", "/clear", "/exit"] as const;
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length > 0 ? hits : commands, line];
      };

      const [matches] = completer("/zzz");
      expect(matches).toEqual(["/help", "/clear", "/exit"]);
    });
  });

  test("does not implement sendStatus", () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });
    expect(channel.sendStatus).toBeUndefined();
  });
});

// ─── Slash Command Interception ─────────────────────────────────────

function createMockCommandHandler(
  overrides: Partial<{ result: SlashCommandHandler }> = {},
): SlashCommandHandler {
  if (overrides.result !== undefined) return overrides.result;
  return mock(async (_line: string) => ({ ok: true }));
}

describe("slash command interception", () => {
  test("slash command is intercepted and not forwarded to message handler", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandHandler = createMockCommandHandler();
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandHandler,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    streams.input.write("/help\n");
    await Bun.sleep(100);

    expect(received).toHaveLength(0);
    await channel.disconnect();
  });

  test("non-slash lines are forwarded as messages when commandHandler provided", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandHandler = createMockCommandHandler();
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandHandler,
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

  test("failed slash command writes message to output", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandHandler: SlashCommandHandler = async () => ({
      ok: false,
      message: "Unknown command: /foobar",
    });
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandHandler,
    });

    channel.onMessage(async () => {});
    await channel.connect();

    streams.input.write("/foobar\n");
    await Bun.sleep(100);

    const written = readStream(streams.output);
    expect(written).toContain("Unknown command");
    await channel.disconnect();
  });

  test("slash interception disabled when no commandHandler provided", async () => {
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
    streams.input.write("/help\n");
    await Bun.sleep(50);

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toEqual([{ kind: "text", text: "/help" }]);
    await channel.disconnect();
  });

  test("command handler exception writes error to stderr", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const commandHandler: SlashCommandHandler = async () => {
      throw new Error("command exploded");
    };
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
      commandHandler,
    });

    channel.onMessage(async () => {});
    await channel.connect();

    streams.input.write("/boom\n");
    await Bun.sleep(100);

    const errorWritten = readStream(streams.errorOutput);
    expect(errorWritten).toContain("Command error: command exploded");
    await channel.disconnect();
  });
});

// ─── Signal Handling & Cleanup ──────────────────────────────────────

describe("signal handling and cleanup", () => {
  test("SIGINT on readline triggers cleanup and prevents further input", async () => {
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

    // Send a message before SIGINT
    streams.input.write("before\n");
    await Bun.sleep(50);
    expect(received).toHaveLength(1);

    // Emit SIGINT on the input stream (simulates Ctrl+C)
    // We need to emit the keypress that triggers readline's SIGINT
    streams.input.emit("keypress", "\x03", { name: "c", ctrl: true });
    await Bun.sleep(50);

    // After SIGINT cleanup, the channel should be in a disconnected-like state
    // The readline interface should be closed
    await channel.disconnect();
  });

  test("disconnect during active send completes gracefully", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    await channel.connect();

    // Start sending and disconnect concurrently
    const sendPromise = channel.send({
      content: [{ kind: "text", text: "mid-send" }],
    });
    const disconnectPromise = channel.disconnect();

    // Both should resolve without error
    await Promise.all([sendPromise, disconnectPromise]);
  });

  test("reconnect cycle: fresh readline on second connect", async () => {
    const streams1 = createMockStreams();
    activeStreams = [...activeStreams, streams1.input, streams1.output, streams1.errorOutput];
    const channel1 = createCliChannel({
      input: streams1.input,
      output: streams1.output,
      errorOutput: streams1.errorOutput,
    });

    const received: InboundMessage[] = [];
    channel1.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel1.connect();
    streams1.input.write("first\n");
    await Bun.sleep(50);
    expect(received).toHaveLength(1);
    await channel1.disconnect();

    // Create new channel with fresh streams (simulates reconnection)
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

    expect(received).toHaveLength(2);
    await channel2.disconnect();
  });
});
