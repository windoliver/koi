import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSafeReplacer } from "./json-replacer.js";
import { createCliOutput } from "./output.js";

function createTestOutput(options?: {
  readonly verbose?: boolean;
  readonly logFormat?: "text" | "json";
}) {
  const stream = new PassThrough();
  const chunks: Uint8Array[] = [];
  stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));

  const output = createCliOutput({
    stream,
    verbose: options?.verbose ?? false,
    logFormat: options?.logFormat,
  });

  return {
    output,
    text: () => Buffer.concat(chunks).toString("utf-8"),
  };
}

/**
 * Parses all NDJSON lines from raw output text into an array of objects.
 */
function parseNdjson(raw: string): readonly Record<string, unknown>[] {
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

describe("createCliOutput — json mode", () => {
  test("writes valid NDJSON lines", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.info("hello");
    output.warn("caution");

    const lines = parseNdjson(text());
    expect(lines).toHaveLength(2);
    // Each line should be valid JSON (parseNdjson would throw if not)
    expect(lines[0]).toBeDefined();
    expect(lines[1]).toBeDefined();
  });

  test("includes level, msg, ts fields", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.info("test message");

    const [entry] = parseNdjson(text());
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("info");
    expect(entry?.msg).toBe("test message");
    expect(typeof entry?.ts).toBe("string");
    // ts should be a valid ISO 8601 date
    expect(Number.isNaN(Date.parse(entry?.ts as string))).toBe(false);
  });

  test("warn level is correct", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.warn("caution ahead");

    const [entry] = parseNdjson(text());
    expect(entry?.level).toBe("warn");
    expect(entry?.msg).toBe("caution ahead");
  });

  test("error includes hint field when provided", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.error("config invalid", "run koi doctor");

    const [entry] = parseNdjson(text());
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
    expect(entry?.msg).toBe("config invalid");
    expect(entry?.hint).toBe("run koi doctor");
  });

  test("error without hint omits hint field", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.error("something broke");

    const [entry] = parseNdjson(text());
    expect(entry).toBeDefined();
    expect(entry?.hint).toBeUndefined();
  });

  test("debug messages only appear when verbose", () => {
    const quiet = createTestOutput({ logFormat: "json", verbose: false });
    quiet.output.debug("hidden");
    expect(quiet.text()).toBe("");

    const loud = createTestOutput({ logFormat: "json", verbose: true });
    loud.output.debug("visible");
    const [entry] = parseNdjson(loud.text());
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("debug");
    expect(entry?.msg).toBe("visible");
  });

  test("success maps to info level", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.success("done");

    const [entry] = parseNdjson(text());
    expect(entry?.level).toBe("info");
    expect(entry?.msg).toBe("done");
  });

  test("hint maps to info level", () => {
    const { output, text } = createTestOutput({ logFormat: "json" });
    output.hint("try this");

    const [entry] = parseNdjson(text());
    expect(entry?.level).toBe("info");
    expect(entry?.msg).toBe("try this");
  });
});

describe("createSafeReplacer", () => {
  test("handles circular references", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;

    const result = JSON.stringify(obj, createSafeReplacer());
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.name).toBe("test");
    expect(parsed.self).toBe("[Circular]");
  });

  test("sanitizes sk- secret patterns", () => {
    const obj = { key: "sk-abc123def456", name: "safe" };
    const result = JSON.stringify(obj, createSafeReplacer());
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.key).toBe("[REDACTED]");
    expect(parsed.name).toBe("safe");
  });

  test("sanitizes Bearer token patterns", () => {
    const obj = { auth: "Bearer eyJhbGciOiJIUzI1NiJ9.test" };
    const result = JSON.stringify(obj, createSafeReplacer());
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.auth).toBe("[REDACTED]");
  });

  test("sanitizes GitHub personal access tokens", () => {
    const obj = { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZab" };
    const result = JSON.stringify(obj, createSafeReplacer());
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.token).toBe("[REDACTED]");
  });

  test("sanitizes AWS access key patterns", () => {
    const obj = { aws: "AKIAIOSFODNN7EXAMPLE" };
    const result = JSON.stringify(obj, createSafeReplacer());
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.aws).toBe("[REDACTED]");
  });

  test("does not redact normal strings", () => {
    const obj = { msg: "just a normal message", count: 42 };
    const result = JSON.stringify(obj, createSafeReplacer());
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.msg).toBe("just a normal message");
    expect(parsed.count).toBe(42);
  });
});
