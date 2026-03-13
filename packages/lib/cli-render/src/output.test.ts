import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createCliOutput } from "./output.js";

function createTestOutput(options?: { verbose?: boolean }) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  const output = createCliOutput({
    stream,
    verbose: options?.verbose ?? false,
  });

  return {
    output,
    text: () => Buffer.concat(chunks).toString("utf-8"),
  };
}

describe("createCliOutput", () => {
  test("info writes dimmed text to stream", () => {
    const { output, text } = createTestOutput();
    output.info("Loading manifest");
    expect(text()).toContain("Loading manifest");
  });

  test("warn writes with warn: prefix", () => {
    const { output, text } = createTestOutput();
    output.warn("missing optional config");
    expect(text()).toContain("warn:");
    expect(text()).toContain("missing optional config");
  });

  test("error writes with error: prefix", () => {
    const { output, text } = createTestOutput();
    output.error("manifest not found");
    expect(text()).toContain("error:");
    expect(text()).toContain("manifest not found");
  });

  test("error with hint writes both lines", () => {
    const { output, text } = createTestOutput();
    output.error("invalid config", "run `koi doctor --repair` to auto-fix");
    const t = text();
    expect(t).toContain("error:");
    expect(t).toContain("invalid config");
    expect(t).toContain("hint:");
    expect(t).toContain("koi doctor --repair");
  });

  test("success writes with checkmark prefix", () => {
    const { output, text } = createTestOutput();
    output.success("Manifest resolved");
    expect(text()).toContain("\u2713");
    expect(text()).toContain("Manifest resolved");
  });

  test("hint writes with hint: prefix", () => {
    const { output, text } = createTestOutput();
    output.hint("try koi doctor");
    expect(text()).toContain("hint:");
    expect(text()).toContain("try koi doctor");
  });

  test("debug is silent when verbose=false", () => {
    const { output, text } = createTestOutput({ verbose: false });
    output.debug("internal detail");
    expect(text()).toBe("");
  });

  test("debug writes when verbose=true", () => {
    const { output, text } = createTestOutput({ verbose: true });
    output.debug("internal detail");
    expect(text()).toContain("internal detail");
  });

  test("isTTY is false for PassThrough streams", () => {
    const { output } = createTestOutput();
    expect(output.isTTY).toBe(false);
  });

  test("spinner is accessible", () => {
    const { output } = createTestOutput();
    expect(output.spinner).toBeDefined();
    expect(typeof output.spinner.start).toBe("function");
    expect(typeof output.spinner.stop).toBe("function");
    expect(typeof output.spinner.update).toBe("function");
  });
});
