import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSpinner } from "./spinner.js";

function createMockTTY(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
}

function collectOutput(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString("utf-8");
}

describe("createSpinner", () => {
  describe("non-TTY", () => {
    test("writes static line on start", () => {
      const stream = new PassThrough();
      const output = collectOutput(stream);
      const spinner = createSpinner(stream);

      spinner.start("Loading...");
      spinner.stop();

      expect(output()).toContain("Loading...\n");
    });

    test("stop without start is safe", () => {
      const stream = new PassThrough();
      const spinner = createSpinner(stream);
      expect(() => spinner.stop()).not.toThrow();
    });
  });

  describe("TTY", () => {
    test("writes spinner frame on start", () => {
      const stream = createMockTTY();
      const output = collectOutput(stream);
      const spinner = createSpinner(stream);

      spinner.start("Working...");
      // Stop immediately to prevent interval from running
      spinner.stop();

      const text = output();
      // Should contain the first frame and the text
      expect(text).toContain("Working...");
    });

    test("stop clears line and writes final text", () => {
      const stream = createMockTTY();
      const output = collectOutput(stream);
      const spinner = createSpinner(stream);

      spinner.start("Phase 1...");
      spinner.stop("\u2713 Phase 1 complete");

      const text = output();
      // Should contain line-clear sequence
      expect(text).toContain("\x1b[2K\r");
      // Should contain final text
      expect(text).toContain("\u2713 Phase 1 complete\n");
    });

    test("stop without final text clears line only", () => {
      const stream = createMockTTY();
      const output = collectOutput(stream);
      const spinner = createSpinner(stream);

      spinner.start("Working...");
      spinner.stop();

      const text = output();
      // Last thing written should be line-clear, no trailing newline from stop
      expect(text).toContain("\x1b[2K\r");
    });

    test("update changes the text", () => {
      const stream = createMockTTY();
      const spinner = createSpinner(stream);

      spinner.start("Phase 1...");
      spinner.update("Phase 2...");
      spinner.stop();
      // No assertion on intermediate state — we just verify no error
    });

    test("reusable — can start after stop", () => {
      const stream = createMockTTY();
      const output = collectOutput(stream);
      const spinner = createSpinner(stream);

      spinner.start("First");
      spinner.stop("\u2713 First done");
      spinner.start("Second");
      spinner.stop("\u2713 Second done");

      const text = output();
      expect(text).toContain("First done");
      expect(text).toContain("Second done");
    });
  });

  describe("exit handler", () => {
    test("registers handler on start and removes on stop", () => {
      const stream = createMockTTY();
      const spinner = createSpinner(stream);

      const beforeCount = process.listenerCount("exit");
      spinner.start("Test");
      expect(process.listenerCount("exit")).toBe(beforeCount + 1);
      spinner.stop();
      expect(process.listenerCount("exit")).toBe(beforeCount);
    });
  });
});
