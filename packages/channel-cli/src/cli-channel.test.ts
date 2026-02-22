/**
 * Tests for the CLI channel adapter.
 *
 * Uses PassThrough streams as mock stdin/stdout/stderr to verify
 * behavior without actual terminal I/O.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
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

afterEach(() => {
  for (const stream of activeStreams) {
    stream.destroy();
  }
  activeStreams = [];
});

describe("createCliChannel", () => {
  // Run the contract test suite from @koi/test-utils
  describe("contract compliance", () => {
    testChannelAdapter({
      createAdapter: () => {
        const streams = createMockStreams();
        activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
        return createCliChannel({
          input: streams.input,
          output: streams.output,
          errorOutput: streams.errorOutput,
        });
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

  test("send handles non-text blocks by writing description to error output", async () => {
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

    const errorWritten = readStream(streams.errorOutput);
    expect(errorWritten).toContain("[file: doc.pdf]");
    expect(errorWritten).toContain("[image: A picture]");
    expect(errorWritten).toContain("[button: Click me]");
    expect(errorWritten).toContain("[custom: chart]");

    // Text output should not contain these
    const textWritten = readStream(streams.output);
    expect(textWritten).not.toContain("[file:");
    expect(textWritten).not.toContain("[image:");

    await channel.disconnect();
  });

  test("send before connect writes to output without error", async () => {
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
    await channel.send(message);

    const written = readStream(streams.output);
    expect(written).toContain("Before connect\n");
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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);

    // Unsubscribe
    unsubscribe();

    // Send another message, handler should NOT receive it
    streams.input.write("after\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
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

  test("file block without name falls back to URL", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const message: OutboundMessage = {
      content: [{ kind: "file", url: "https://example.com/doc.pdf", mimeType: "application/pdf" }],
    };
    await channel.send(message);

    const errorWritten = readStream(streams.errorOutput);
    expect(errorWritten).toContain("[file: https://example.com/doc.pdf]");
  });

  test("image block without alt falls back to URL", async () => {
    const streams = createMockStreams();
    activeStreams = [...activeStreams, streams.input, streams.output, streams.errorOutput];
    const channel = createCliChannel({
      input: streams.input,
      output: streams.output,
      errorOutput: streams.errorOutput,
    });

    const message: OutboundMessage = {
      content: [{ kind: "image", url: "https://example.com/pic.png" }],
    };
    await channel.send(message);

    const errorWritten = readStream(streams.errorOutput);
    expect(errorWritten).toContain("[image: https://example.com/pic.png]");
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should only receive one message, not duplicated
    expect(received).toHaveLength(1);

    await channel.disconnect();
  });
});
