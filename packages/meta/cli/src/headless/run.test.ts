import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineInput } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { HeadlessOutcome } from "./run.js";
import { emitHeadlessSessionStart, emitPreRunTimeoutResult, runHeadless } from "./run.js";

/**
 * Wrapper that mirrors what start.ts does: emit session_start, run the
 * engine, then emit the terminal result. Keeps tests concise after the
 * session_start / result-emission refactor (session_start moved out of
 * runHeadless and into the caller so the deadline backstop cannot
 * double-emit a session header).
 */
async function runAndEmit(
  opts: Parameters<typeof runHeadless>[0],
  override?: Parameters<HeadlessOutcome["emitResult"]>[0],
): Promise<number> {
  emitHeadlessSessionStart(opts.sessionId, opts.writeStdout);
  const outcome = await runHeadless(opts);
  outcome.emitResult(override);
  return outcome.exitCode;
}

type FakeRuntime = {
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
};

function runtimeFromEvents(events: readonly EngineEvent[]): FakeRuntime {
  return {
    run: () =>
      (async function* () {
        for (const event of events) yield event;
      })(),
  };
}

function runtimeFromFn(fn: (signal: AbortSignal) => AsyncIterable<EngineEvent>): FakeRuntime {
  return {
    run: (input) => fn(input.signal ?? new AbortController().signal),
  };
}

function throwingIterable(err: unknown): AsyncIterable<EngineEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
      return {
        next: () => Promise.reject(err),
      };
    },
  };
}

const DONE: EngineEvent = {
  kind: "done",
  output: {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      durationMs: 0,
    },
  },
};

describe("emitPreRunTimeoutResult", () => {
  test("emits only the terminal result (session_start is caller-owned)", () => {
    const stdout: string[] = [];
    emitPreRunTimeoutResult(
      "sess-xyz",
      (s) => stdout.push(s),
      "runtime wedged past --max-duration-ms",
    );
    const lines = stdout.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      kind: "result",
      sessionId: "sess-xyz",
      ok: false,
      exitCode: 4,
      error: "runtime wedged past --max-duration-ms",
    });
  });

  test("combined with emitHeadlessSessionStart produces a single session_start + result", () => {
    const stdout: string[] = [];
    emitHeadlessSessionStart("s", (c) => stdout.push(c));
    emitPreRunTimeoutResult("s", (c) => stdout.push(c), "wedged");
    const parsed = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: "session_start", sessionId: "s" });
    expect(parsed[1]).toMatchObject({ kind: "result", exitCode: 4 });
    // Exactly one session_start — the whole point of the refactor.
    expect(parsed.filter((e) => e.kind === "session_start")).toHaveLength(1);
  });
});

describe("runHeadless", () => {
  test("emits session_start then result on successful run", async () => {
    const stdout: string[] = [];
    const exitCode = await runAndEmit({
      sessionId: "sess-1",
      prompt: "ping",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([DONE]),
    });
    expect(exitCode).toBe(0);
    const lines = stdout.join("").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      kind: "session_start",
      sessionId: "sess-1",
    });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      kind: "result",
      sessionId: "sess-1",
      ok: true,
      exitCode: 0,
    });
  });

  test("translates text_delta events into assistant_text NDJSON", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        { kind: "text_delta", delta: "hel" },
        { kind: "text_delta", delta: "lo" },
        DONE,
      ]),
    });
    const parsed = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const texts = parsed.filter((e) => e.kind === "assistant_text").map((e) => e.text);
    expect(texts).toEqual(["hel", "lo"]);
  });

  test("skips empty text_delta events", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([{ kind: "text_delta", delta: "" }, DONE]),
    });
    const kinds = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).kind);
    expect(kinds).not.toContain("assistant_text");
  });

  test("emits tool identity + payload summary (no raw args or result values)", async () => {
    // CI log safety: args/result are summarized (type + size), never the
    // actual values, so secrets in tool inputs/outputs don't end up in
    // build logs. See summarizePayload in run.ts.
    const stdout: string[] = [];
    const callId = toolCallId("c1");
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "tool_call_start",
          callId,
          toolName: "Bash",
          args: { cmd: "ls", secret: "token-xyz" },
        },
        { kind: "tool_result", callId, output: "file.txt\n" },
        DONE,
      ]),
    });
    const parsed = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const call = parsed.find((e) => e.kind === "tool_call");
    const result = parsed.find((e) => e.kind === "tool_result");
    expect(call).toMatchObject({
      toolName: "Bash",
      args: { type: "object", size: 2 },
    });
    // No raw args leak.
    expect(JSON.stringify(call)).not.toContain("token-xyz");
    expect(JSON.stringify(call)).not.toContain("ls");
    expect(result).toMatchObject({
      toolName: "Bash",
      ok: true,
      result: { type: "string", size: "file.txt\n".length },
    });
    expect(JSON.stringify(result)).not.toContain("file.txt");
  });

  test("redacts TOOL_EXECUTION_ERROR payload (code + errorSize, no raw message)", async () => {
    // Raw error messages from query-engine can include Bash stderr
    // fragments, URLs, or tokens. Headless emits only the fixed-vocabulary
    // code plus a length marker so CI logs don't carry sensitive text.
    const stdout: string[] = [];
    const callId = toolCallId("c1");
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        { kind: "tool_call_start", callId, toolName: "Bash", args: {} },
        {
          kind: "tool_result",
          callId,
          output: {
            error: "curl -H Authorization: Bearer token-xyz failed",
            code: "TOOL_EXECUTION_ERROR",
          },
        },
        DONE,
      ]),
    });
    const result = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({
      toolName: "Bash",
      ok: false,
      result: {
        code: "TOOL_EXECUTION_ERROR",
        errorSize: "curl -H Authorization: Bearer token-xyz failed".length,
      },
    });
    // The secret MUST NOT appear anywhere in the NDJSON line.
    expect(JSON.stringify(result)).not.toContain("token-xyz");
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });

  test("returns exit code 4 on max-duration-ms timeout and the engine receives the abort", async () => {
    const stdout: string[] = [];
    let sawAbort = false;
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "slow",
      maxDurationMs: 10,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromFn((signal) =>
        (async function* (): AsyncIterable<EngineEvent> {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              sawAbort = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
          yield DONE;
        })(),
      ),
    });
    expect(exitCode).toBe(4);
    expect(sawAbort).toBe(true);
    const last = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(last).toMatchObject({ kind: "result", ok: false, exitCode: 4 });
  });

  test("returns exit code 2 when runtime throws a PERMISSION KoiError", async () => {
    const stdout: string[] = [];
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromFn(() =>
        throwingIterable({ code: "PERMISSION", message: "denied", retryable: false }),
      ),
    });
    expect(exitCode).toBe(2);
    // Catch-path redaction: the raw error message ("denied") is redacted
    // into a classification + length marker in the NDJSON envelope.
    // The raw text is still available on stderr for human debugging.
    const last = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(last).toMatchObject({ kind: "result", ok: false, exitCode: 2 });
    expect(last.error).toContain("chars redacted");
  });

  test("unexpected throw surfaces error class name in both stdout and stderr", async () => {
    // Codex round-5 observability fix: raw error text is redacted, but
    // the classifier (constructor name / KoiError:code) must be visible
    // so operators can distinguish retry-safe from retry-unsafe failures
    // without reading the redacted payload.
    class ProviderOutageError extends Error {}
    const stdout: string[] = [];
    const stderr: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: (s) => stderr.push(s),
      runtime: runtimeFromFn(() => throwingIterable(new ProviderOutageError("provider-xyz 503"))),
    });
    const result = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.kind === "result");
    expect(result.error).toContain("[ProviderOutageError]");
    expect(stderr.join("")).toContain("[ProviderOutageError]");
    // Raw message still redacted.
    expect(result.error).not.toContain("provider-xyz");
    expect(stderr.join("")).not.toContain("503");
  });

  test("KoiError-shaped throw surfaces the code in the classifier", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromFn(() =>
        throwingIterable({ code: "RATE_LIMIT", message: "too many", retryable: true }),
      ),
    });
    const result = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.kind === "result");
    expect(result.error).toContain("[KoiError:RATE_LIMIT]");
    expect(result.error).not.toContain("too many");
  });

  test("returns exit code 5 on unexpected throw; stderr is redacted too (no raw text)", async () => {
    // CI stderr is captured alongside stdout, so raw exception text on
    // stderr is the same exfiltration vector. Both streams must emit
    // only a classification + length marker.
    const stderr: string[] = [];
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: (s) => stderr.push(s),
      runtime: runtimeFromFn(() =>
        throwingIterable(new Error("Bearer sk-xyz failed at https://api.example.com")),
      ),
    });
    expect(exitCode).toBe(5);
    const stderrText = stderr.join("");
    expect(stderrText).toContain("internal error");
    expect(stderrText).toContain("chars redacted");
    // The secret MUST NOT appear on stderr either.
    expect(stderrText).not.toContain("Bearer");
    expect(stderrText).not.toContain("sk-xyz");
    expect(stderrText).not.toContain("api.example.com");
  });

  test("returns exit code 1 when engine stream ends without 'done'", async () => {
    const stdout: string[] = [];
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([{ kind: "text_delta", delta: "partial" }]),
    });
    expect(exitCode).toBe(1);
  });

  test("done event with stopReason=max_turns → exit 3 (BUDGET_EXCEEDED)", async () => {
    const stdout: string[] = [];
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "max_turns",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        },
      ]),
    });
    expect(exitCode).toBe(3);
    const last = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(last).toMatchObject({ kind: "result", ok: false, exitCode: 3 });
  });

  test("approval-handler deny reason (headless interactive) → exit 2", async () => {
    // Matches the headlessDenyHandler in start.ts: fail-closed deny reason
    // for paths that fall through the permission BACKEND to the approval
    // HANDLER (Bash uncertain-AST elicit, MCP tools requesting approval).
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
            metadata: {
              errorMessage: "headless mode: interactive approval is not available",
            },
          },
        },
      ]),
    });
    expect(exitCode).toBe(2);
  });

  test("timedOut + engine done(stopReason=interrupted) → exit 4 (not 1)", async () => {
    // The real engine remaps aborted runs to stopReason "interrupted" on the
    // done event (koi.ts:1458). If our deadline timer fired, that must
    // surface as TIMEOUT regardless.
    const stdout: string[] = [];
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: 10,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromFn((signal) =>
        (async function* (): AsyncIterable<EngineEvent> {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield {
            kind: "done",
            output: {
              content: [],
              stopReason: "interrupted",
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 0,
                durationMs: 0,
              },
            },
          };
        })(),
      ),
    });
    expect(exitCode).toBe(4);
    const last = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(last).toMatchObject({ kind: "result", exitCode: 4 });
  });

  test("done event with stopReason=max_turns + 'Duration limit exceeded' → exit 4 (not BUDGET)", async () => {
    // Engine wall-clock guard message shape (engine-compose/src/guards.ts).
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "max_turns",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
            metadata: { errorMessage: "Duration limit exceeded: 5000ms" },
          },
        },
      ]),
    });
    expect(exitCode).toBe(4);
  });

  test("done event with stopReason=max_turns + timeout marker → exit 4 (not BUDGET)", async () => {
    // The engine catch path remaps KoiRuntimeError(TIMEOUT) to stopReason
    // "max_turns" and embeds the timeout message in metadata. Headless
    // must surface this as TIMEOUT (4), not BUDGET_EXCEEDED (3).
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "max_turns",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
            metadata: { errorMessage: "model call timed out after 30000ms" },
          },
        },
      ]),
    });
    expect(exitCode).toBe(4);
  });

  test("emitResult override surfaces teardown failure after a FAILED run (not just a successful one)", async () => {
    // Regression for Codex round-cap finding: shutdownFailed must override
    // any exit code, not only the 0 case. A PERMISSION_DENIED (2) run whose
    // teardown also fails must surface INTERNAL (5) so CI retry/recovery
    // logic sees the teardown problem, not just the original policy denial.
    const stdout: string[] = [];
    emitHeadlessSessionStart("s", (c) => stdout.push(c));
    const outcome = await runHeadless({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (c) => stdout.push(c),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
            metadata: { errorMessage: 'Tool "Bash" is denied by policy' },
          },
        },
      ]),
    });
    expect(outcome.exitCode).toBe(2);
    // Caller (start.ts) detects shutdownFailed and overrides.
    outcome.emitResult({
      exitCode: 5,
      error: "teardown failure (run exited 2); see stderr",
    });
    const last = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(last).toMatchObject({
      kind: "result",
      ok: false,
      exitCode: 5,
    });
    expect(last.error).toContain("run exited 2");
  });

  test("emitResult override surfaces a shutdown failure after a successful run", async () => {
    const stdout: string[] = [];
    const outcome = await runHeadless({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([DONE]),
    });
    expect(outcome.exitCode).toBe(0);
    outcome.emitResult({ exitCode: 5, error: "teardown failed" });
    const last = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(last).toMatchObject({
      kind: "result",
      ok: false,
      exitCode: 5,
      error: "teardown failed",
    });
  });

  test("emitResult is idempotent (ignores second call)", async () => {
    const stdout: string[] = [];
    const outcome = await runHeadless({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([DONE]),
    });
    outcome.emitResult();
    outcome.emitResult({ exitCode: 5, error: "should be ignored" });
    const resultLines = stdout
      .join("")
      .trim()
      .split("\n")
      .filter((l) => JSON.parse(l).kind === "result");
    expect(resultLines).toHaveLength(1);
    expect(JSON.parse(resultLines[0] ?? "")).toMatchObject({ exitCode: 0 });
  });

  test("done event with stopReason=interrupted → exit 1", async () => {
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "interrupted",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        },
      ]),
    });
    expect(exitCode).toBe(1);
  });

  test("done event with stopReason=error + permission marker → exit 2", async () => {
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
            metadata: { errorMessage: 'Tool "Bash" is denied by policy' },
          },
        },
      ]),
    });
    expect(exitCode).toBe(2);
  });

  test("done event with stopReason=error + default-deny marker → exit 2", async () => {
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
            metadata: { errorMessage: 'Tool "X" not in allow list (default deny)' },
          },
        },
      ]),
    });
    expect(exitCode).toBe(2);
  });

  test("done event with stopReason=error → exit 1 (AGENT_FAILURE)", async () => {
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [],
            stopReason: "error",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        },
      ]),
    });
    expect(exitCode).toBe(1);
  });

  test("redacts engine '[Turn failed: <msg>]' banners in text_delta (no secret leak)", async () => {
    // Regression: engine koi.ts:1474-1493 interpolates error.message
    // verbatim into the text_delta banner. In headless mode the banner
    // must not forward raw error text (Bash stderr, URLs, tokens) to
    // stdout — CI captures it.
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "text_delta",
          delta:
            "\n[Turn failed: curl -H Authorization: Bearer token-xyz failed at https://api.example.com.]\n",
        },
        DONE,
      ]),
    });
    const text = stdout.join("");
    expect(text).not.toContain("token-xyz");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("api.example.com");
    expect(text).toContain("[Turn failed:");
    expect(text).toContain("chars redacted");
  });

  test("redacts '[Turn stopped: <msg>. Raise the session budget ...]' banners", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "text_delta",
          delta:
            "\n[Turn stopped: /secret/path/bucket failed. Raise the session budget or resubmit to continue.]\n",
        },
        DONE,
      ]),
    });
    const text = stdout.join("");
    expect(text).not.toContain("/secret/path/bucket");
    expect(text).toContain("[Turn stopped:");
    expect(text).toContain("chars redacted");
  });

  test("leaves '[Turn interrupted before the model produced a reply.]' unchanged (no interpolation)", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "text_delta",
          delta: "\n[Turn interrupted before the model produced a reply.]\n",
        },
        DONE,
      ]),
    });
    expect(stdout.join("")).toContain("[Turn interrupted before the model produced a reply.]");
  });

  test("falls back to done.output.content when no text_delta was emitted", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        {
          kind: "done",
          output: {
            content: [{ kind: "text", text: "final answer" }],
            stopReason: "completed",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        },
      ]),
    });
    const events = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const textEvent = events.find((e) => e.kind === "assistant_text");
    expect(textEvent?.text).toBe("final answer");
  });

  test("does NOT emit fallback text when deltas were already streamed", async () => {
    const stdout: string[] = [];
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        { kind: "text_delta", delta: "hel" },
        { kind: "text_delta", delta: "lo" },
        {
          kind: "done",
          output: {
            content: [{ kind: "text", text: "hello" }],
            stopReason: "completed",
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: 0,
            },
          },
        },
      ]),
    });
    const texts = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "assistant_text")
      .map((e) => e.text);
    expect(texts).toEqual(["hel", "lo"]);
  });

  test("tool_result with TOOL_EXECUTION_ERROR payload reports ok: false", async () => {
    const stdout: string[] = [];
    const callId = toolCallId("c1");
    await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      writeStdout: (s) => stdout.push(s),
      writeStderr: () => {},
      runtime: runtimeFromEvents([
        { kind: "tool_call_start", callId, toolName: "Bash", args: { cmd: "ls" } },
        {
          kind: "tool_result",
          callId,
          output: { error: "boom", code: "TOOL_EXECUTION_ERROR" },
        },
        DONE,
      ]),
    });
    const result = stdout
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({
      toolName: "Bash",
      ok: false,
    });
  });

  test("externalSignal abort under --max-duration-ms → exit 1 (AGENT_FAILURE), not 4", async () => {
    const external = new AbortController();
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: 10_000, // long timeout, will NOT fire
      externalSignal: external.signal,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromFn((signal) =>
        (async function* (): AsyncIterable<EngineEvent> {
          queueMicrotask(() => external.abort());
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new DOMException("aborted", "AbortError"));
            });
          });
          yield DONE;
        })(),
      ),
    });
    expect(exitCode).toBe(1);
  });

  test("already-aborted externalSignal on entry → short-circuit, runtime.run() never called", async () => {
    // Trust-boundary: if the operator cancelled during bootstrap, headless
    // must NOT start the engine. Fail closed: return a cancelled outcome
    // without invoking runtime.run() at all.
    const external = new AbortController();
    external.abort();
    let engineStartedRun = false;
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      externalSignal: external.signal,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromFn(() =>
        (async function* (): AsyncIterable<EngineEvent> {
          engineStartedRun = true;
          yield DONE;
        })(),
      ),
    });
    expect(engineStartedRun).toBe(false);
    expect(exitCode).toBe(1);
  });

  test("externalSignal aborts the engine (SIGINT-style)", async () => {
    const external = new AbortController();
    let sawAbort = false;
    const exitCode = await runAndEmit({
      sessionId: "s",
      prompt: "x",
      maxDurationMs: undefined,
      externalSignal: external.signal,
      writeStdout: () => {},
      writeStderr: () => {},
      runtime: runtimeFromFn((signal) =>
        (async function* (): AsyncIterable<EngineEvent> {
          queueMicrotask(() => external.abort());
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              sawAbort = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
          yield DONE;
        })(),
      ),
    });
    expect(sawAbort).toBe(true);
    // No --max-duration-ms, so external abort is treated as agent failure / internal.
    expect([1, 5]).toContain(exitCode);
  });
});
