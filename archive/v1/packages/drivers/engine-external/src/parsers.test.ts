import { describe, expect, test } from "bun:test";
import { createJsonLinesParser, createLineParser, createTextDeltaParser } from "./parsers.js";

describe("createTextDeltaParser", () => {
  test("stdout chunk becomes text_delta event", () => {
    const parser = createTextDeltaParser()();
    const result = parser.parseStdout("hello world");

    expect(result.events).toEqual([{ kind: "text_delta", delta: "hello world" }]);
    expect(result.turnComplete).toBe(false);
  });

  test("stderr chunk becomes custom(stderr) event", () => {
    const parser = createTextDeltaParser()();
    const events = parser.parseStderr("error occurred");

    expect(events).toEqual([{ kind: "custom", type: "stderr", data: "error occurred" }]);
  });

  test("flush returns empty array", () => {
    const parser = createTextDeltaParser()();
    expect(parser.flush()).toEqual([]);
  });

  test("never signals turnComplete", () => {
    const parser = createTextDeltaParser()();
    const r1 = parser.parseStdout("chunk 1");
    const r2 = parser.parseStdout("chunk 2");

    expect(r1.turnComplete).toBe(false);
    expect(r2.turnComplete).toBe(false);
  });
});

describe("createJsonLinesParser", () => {
  test("valid JSON line with EngineEvent shape is emitted directly", () => {
    const parser = createJsonLinesParser()();
    const result = parser.parseStdout('{"kind":"text_delta","delta":"hello"}\n');

    expect(result.events).toEqual([{ kind: "text_delta", delta: "hello" }]);
    expect(result.turnComplete).toBe(false);
  });

  test("invalid JSON line falls back to text_delta", () => {
    const parser = createJsonLinesParser()();
    const result = parser.parseStdout("not json at all\n");

    expect(result.events).toEqual([{ kind: "text_delta", delta: "not json at all\n" }]);
  });

  test("partial lines across chunks are buffered correctly", () => {
    const parser = createJsonLinesParser()();

    // First chunk: partial line
    const r1 = parser.parseStdout('{"kind":"text_del');
    expect(r1.events).toEqual([]);

    // Second chunk: completes the line
    const r2 = parser.parseStdout('ta","delta":"hi"}\n');
    expect(r2.events).toEqual([{ kind: "text_delta", delta: "hi" }]);
  });

  test('{"kind":"done"} sets turnComplete to true but does not forward the event', () => {
    const parser = createJsonLinesParser()();
    const result = parser.parseStdout(
      '{"kind":"done","output":{"content":[],"stopReason":"completed","metrics":{"totalTokens":0,"inputTokens":0,"outputTokens":0,"turns":1,"durationMs":100}}}\n',
    );

    expect(result.turnComplete).toBe(true);
    // Done events are not forwarded — the adapter constructs its own
    expect(result.events.length).toBe(0);
  });

  test("empty lines are skipped", () => {
    const parser = createJsonLinesParser()();
    const result = parser.parseStdout("\n\n\n");

    expect(result.events).toEqual([]);
  });

  test("flush emits remaining buffered partial line as text_delta", () => {
    const parser = createJsonLinesParser()();
    parser.parseStdout("partial content");

    const flushed = parser.flush();
    expect(flushed).toEqual([{ kind: "text_delta", delta: "partial content" }]);
  });

  test("flush returns empty on fresh state", () => {
    const parser = createJsonLinesParser()();
    expect(parser.flush()).toEqual([]);
  });

  test("stderr maps to custom(stderr) event", () => {
    const parser = createJsonLinesParser()();
    const events = parser.parseStderr("error line");

    expect(events).toEqual([{ kind: "custom", type: "stderr", data: "error line" }]);
  });

  test("multiple JSON lines in one chunk", () => {
    const parser = createJsonLinesParser()();
    const result = parser.parseStdout(
      '{"kind":"text_delta","delta":"a"}\n{"kind":"text_delta","delta":"b"}\n',
    );

    expect(result.events).toEqual([
      { kind: "text_delta", delta: "a" },
      { kind: "text_delta", delta: "b" },
    ]);
  });

  test("JSON object without kind falls back to text_delta", () => {
    const parser = createJsonLinesParser()();
    const result = parser.parseStdout('{"foo":"bar"}\n');

    expect(result.events).toEqual([{ kind: "text_delta", delta: '{"foo":"bar"}\n' }]);
  });
});

describe("createLineParser", () => {
  test("calls mapping function per complete line", () => {
    const lines: string[] = [];
    const parser = createLineParser((line, source) => {
      lines.push(`${source}:${line}`);
      return { events: [{ kind: "text_delta" as const, delta: line }] };
    })();

    parser.parseStdout("line1\nline2\n");

    expect(lines).toEqual(["stdout:line1", "stdout:line2"]);
  });

  test("undefined return skips line", () => {
    const parser = createLineParser((line) => {
      if (line === "skip") return undefined;
      return { events: [{ kind: "text_delta" as const, delta: line }] };
    })();

    const result = parser.parseStdout("keep\nskip\nalso keep\n");

    expect(result.events).toEqual([
      { kind: "text_delta", delta: "keep" },
      { kind: "text_delta", delta: "also keep" },
    ]);
  });

  test("turnComplete from mapping function is propagated", () => {
    const parser = createLineParser((line) => ({
      events: [{ kind: "text_delta" as const, delta: line }],
      turnComplete: line === "END",
    }))();

    const r1 = parser.parseStdout("hello\n");
    expect(r1.turnComplete).toBe(false);

    const r2 = parser.parseStdout("END\n");
    expect(r2.turnComplete).toBe(true);
  });

  test("stderr lines are also mapped", () => {
    const parser = createLineParser((line, source) => ({
      events: [{ kind: "custom" as const, type: source, data: line }],
    }))();

    const events = parser.parseStderr("err line\n");
    expect(events).toEqual([{ kind: "custom", type: "stderr", data: "err line" }]);
  });

  test("flush emits remaining buffered lines", () => {
    const parser = createLineParser((line) => ({
      events: [{ kind: "text_delta" as const, delta: line }],
    }))();

    parser.parseStdout("no newline");
    const flushed = parser.flush();
    expect(flushed).toEqual([{ kind: "text_delta", delta: "no newline" }]);
  });

  test("flush returns empty on fresh state", () => {
    const parser = createLineParser(() => ({
      events: [{ kind: "text_delta" as const, delta: "x" }],
    }))();

    expect(parser.flush()).toEqual([]);
  });
});
