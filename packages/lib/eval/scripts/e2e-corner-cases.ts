/**
 * E2E corner-case driver for @koi/eval.
 *
 *   bun run packages/lib/eval/scripts/e2e-corner-cases.ts
 *
 * Walks every gate in the framework — runner cancellation paths, store
 * round-trips, regression-gate fail-closed cases — using deterministic
 * mock agents. Prints PASS/FAIL per scenario; exits 1 on any failure.
 *
 * No model, no network. Add a live-model section by importing
 * `@koi/runtime` and wrapping `runtime.run()` as an `AgentHandle`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, ToolCallId } from "@koi/core";
import { exactMatch } from "../src/graders/exact-match.js";
import { toolCall } from "../src/graders/tool-call.js";
import { compareRuns } from "../src/regression.js";
import { runEval } from "../src/runner.js";
import { runSelfTest } from "../src/self-test.js";
import { createFsStore } from "../src/store.js";
import type { AgentHandle, EvalTask } from "../src/types.js";

let pass = 0;
let fail = 0;
const log = (name: string, ok: boolean, detail = ""): void => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const doneEvent: EngineEvent = {
  kind: "done",
  output: {
    content: [{ kind: "text", text: "ok" }],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  },
};

const fakeAgent = (events: readonly EngineEvent[]): AgentHandle => ({
  stream: (): AsyncIterable<EngineEvent> => ({
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  }),
});

const mkTask = (
  id: string,
  text: string,
  graders: EvalTask["graders"],
  extra: Partial<EvalTask> = {},
): EvalTask => ({
  id,
  name: id,
  input: { kind: "text", text } as EvalTask["input"],
  expected: { kind: "text", pattern: text },
  graders,
  ...extra,
});

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "eval-e2e-"));
  try {
    // ------------------------------------------------------------------
    // 1. Happy path
    // ------------------------------------------------------------------
    {
      const r = await runEval({
        name: "happy",
        tasks: [mkTask("t1", "ok", [exactMatch()])],
        agentFactory: () => fakeAgent([{ kind: "text_delta", delta: "ok" }, doneEvent]),
        idGen: () => "happy-1",
      });
      log("happy path → pass", r.trials[0]?.status === "pass");
    }

    // ------------------------------------------------------------------
    // 2. Pre-aborted upstream signal: confirmed, suite continues
    // ------------------------------------------------------------------
    {
      const ctrl = new AbortController();
      ctrl.abort(new Error("preaborted"));
      const r = await runEval({
        name: "pre-aborted",
        tasks: [
          {
            ...mkTask("t1", "x", [exactMatch()]),
            input: { kind: "text", text: "x", signal: ctrl.signal } as EvalTask["input"],
          },
          mkTask("t2", "ok", [exactMatch()]),
        ],
        agentFactory: () => fakeAgent([{ kind: "text_delta", delta: "ok" }, doneEvent]),
        idGen: () => "pre-1",
      });
      log(
        "pre-aborted upstream → confirmed, suite continues",
        r.trials[0]?.cancellation === "confirmed" &&
          r.aborted === undefined &&
          r.trials.length === 2,
      );
    }

    // ------------------------------------------------------------------
    // 3. Hung agent (no return, ignores signal): unconfirmed → suite aborts
    // ------------------------------------------------------------------
    {
      const r = await runEval({
        name: "hung",
        tasks: [
          { ...mkTask("t1", "x", [exactMatch()]), timeoutMs: 20 },
          mkTask("t2", "ok", [exactMatch()]),
        ],
        agentFactory: () => ({
          stream: (): AsyncIterable<EngineEvent> => ({
            [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
          }),
        }),
        disposeTimeoutMs: 20,
        idGen: () => "hung-1",
      });
      log(
        "hung agent → unconfirmed, suite aborts before t2",
        r.trials[0]?.cancellation === "unconfirmed" && r.aborted === true && r.trials.length === 1,
      );
    }

    // ------------------------------------------------------------------
    // 4. Signal-only cooperative agent (no return()): confirmed
    // ------------------------------------------------------------------
    {
      const r = await runEval({
        name: "signal-only",
        tasks: [{ ...mkTask("t1", "x", [exactMatch()]), timeoutMs: 20 }],
        agentFactory: () => ({
          stream: (input): AsyncIterable<EngineEvent> => ({
            [Symbol.asyncIterator]: () => ({
              next: (): Promise<IteratorResult<EngineEvent>> =>
                new Promise<IteratorResult<EngineEvent>>((resolve) => {
                  if (input.signal === undefined) return;
                  if (input.signal.aborted) {
                    resolve({ value: undefined as unknown as EngineEvent, done: true });
                    return;
                  }
                  input.signal.addEventListener(
                    "abort",
                    () => resolve({ value: undefined as unknown as EngineEvent, done: true }),
                    { once: true },
                  );
                }),
            }),
          }),
        }),
        disposeTimeoutMs: 20,
        idGen: () => "so-1",
      });
      log(
        "signal-only cooperative → confirmed",
        r.trials[0]?.cancellation === "confirmed",
        r.trials[0]?.cancellation,
      );
    }

    // ------------------------------------------------------------------
    // 5. max_turns is success, not error
    // ------------------------------------------------------------------
    {
      const r = await runEval({
        name: "max-turns",
        tasks: [mkTask("t1", "ok", [exactMatch()])],
        agentFactory: () =>
          fakeAgent([
            { kind: "text_delta", delta: "ok" },
            {
              kind: "done",
              output: {
                content: [{ kind: "text", text: "ok" }],
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
        idGen: () => "mt-1",
      });
      log("max_turns → success, not error", r.trials[0]?.status === "pass");
    }

    // ------------------------------------------------------------------
    // 6. toolCall: extra unexpected call fails by default
    // ------------------------------------------------------------------
    {
      const callId = (s: string): ToolCallId => s as ToolCallId;
      const transcript: readonly EngineEvent[] = [
        { kind: "tool_call_start", toolName: "read", callId: callId("c1") },
        { kind: "tool_result", callId: callId("c1"), output: "ok" },
        { kind: "tool_call_start", toolName: "delete", callId: callId("c2") },
        { kind: "tool_result", callId: callId("c2"), output: "ok" },
        doneEvent,
      ];
      const r = await runEval({
        name: "tool-extras",
        tasks: [
          {
            id: "t1",
            name: "t1",
            input: { kind: "text", text: "x" } as EvalTask["input"],
            expected: { kind: "tool_calls", calls: [{ toolName: "read" }] },
            graders: [toolCall()],
          },
        ],
        agentFactory: () => fakeAgent(transcript),
        idGen: () => "te-1",
      });
      log("toolCall fails on unexpected extra (default)", r.trials[0]?.status === "fail");
    }

    // ------------------------------------------------------------------
    // 7. toolCall: streamed args via tool_call_delta
    // ------------------------------------------------------------------
    {
      const callId = (s: string): ToolCallId => s as ToolCallId;
      const transcript: readonly EngineEvent[] = [
        { kind: "tool_call_start", toolName: "search", callId: callId("c1") },
        { kind: "tool_call_delta", callId: callId("c1"), delta: '{"q":"' },
        { kind: "tool_call_delta", callId: callId("c1"), delta: 'hi"}' },
        { kind: "tool_result", callId: callId("c1"), output: "ok" },
        doneEvent,
      ];
      const r = await runEval({
        name: "tool-deltas",
        tasks: [
          {
            id: "t1",
            name: "t1",
            input: { kind: "text", text: "x" } as EvalTask["input"],
            expected: {
              kind: "tool_calls",
              calls: [{ toolName: "search", args: { q: "hi" } }],
            },
            graders: [toolCall()],
          },
        ],
        agentFactory: () => fakeAgent(transcript),
        idGen: () => "td-1",
      });
      log(
        "toolCall reconstructs args from deltas",
        r.trials[0]?.status === "pass",
        r.trials[0]?.scores[0]?.reasoning,
      );
    }

    // ------------------------------------------------------------------
    // 8. Store: DAG aliasing round-trips
    // ------------------------------------------------------------------
    {
      const store = createFsStore(root);
      const r = await runEval({
        name: "dag",
        tasks: [mkTask("t1", "ok", [exactMatch()])],
        agentFactory: () => {
          const shared = { hello: "world" };
          return fakeAgent([
            {
              kind: "tool_result",
              callId: "c1" as ToolCallId,
              output: { a: shared, b: shared },
            },
            { kind: "text_delta", delta: "ok" },
            doneEvent,
          ]);
        },
        idGen: () => "dag-1",
      });
      await store.save(r);
      const loaded = await store.load("dag-1", "dag");
      const out = loaded?.trials[0]?.transcript[0] as { output: { a: unknown; b: unknown } };
      log(
        "store round-trips DAG-aliased payload",
        JSON.stringify(out.output.a) === JSON.stringify({ hello: "world" }) &&
          JSON.stringify(out.output.b) === JSON.stringify({ hello: "world" }),
      );
    }

    // ------------------------------------------------------------------
    // 9. Store: invalid Date does not crash save
    // ------------------------------------------------------------------
    {
      const store = createFsStore(root);
      const r = await runEval({
        name: "baddate",
        tasks: [mkTask("t1", "ok", [exactMatch()])],
        agentFactory: () =>
          fakeAgent([
            { kind: "tool_result", callId: "c1" as ToolCallId, output: { when: new Date("nope") } },
            { kind: "text_delta", delta: "ok" },
            doneEvent,
          ]),
        idGen: () => "bd-1",
      });
      await store.save(r);
      const loaded = await store.load("bd-1", "baddate");
      const out = loaded?.trials[0]?.transcript[0] as { output: { when: Date } };
      log(
        "store tolerates invalid Date in payload",
        out.output.when instanceof Date && Number.isNaN(out.output.when.getTime()),
      );
    }

    // ------------------------------------------------------------------
    // 10. Store: tampered baseline is rejected by latest()
    // ------------------------------------------------------------------
    {
      const store = createFsStore(root);
      const r = await runEval({
        name: "tampered",
        tasks: [mkTask("t1", "ok", [exactMatch()])],
        agentFactory: () => fakeAgent([{ kind: "text_delta", delta: "ok" }, doneEvent]),
        idGen: () => "tmp-1",
      });
      await store.save(r);
      const filePath = join(
        root,
        encodeURIComponent("tampered"),
        `${encodeURIComponent("tmp-1")}.json`,
      );
      const tampered = { ...r, summary: { ...r.summary, passRate: 1, trialCount: 99 } };
      await writeFile(filePath, JSON.stringify(tampered), "utf8");
      let threw = false;
      try {
        await store.latest("tampered");
      } catch {
        threw = true;
      }
      log("store fails closed on tampered baseline", threw);
    }

    // ------------------------------------------------------------------
    // 11. Regression: new task with sub-perfect mean score fails
    // ------------------------------------------------------------------
    {
      const baseline = await runEval({
        name: "reg",
        tasks: [mkTask("t1", "ok", [exactMatch()])],
        agentFactory: () => fakeAgent([{ kind: "text_delta", delta: "ok" }, doneEvent]),
        idGen: () => "base",
      });
      // current run adds a new task that scores below 1.0
      const partial: EngineEvent[] = [
        { kind: "text_delta", delta: "wrong" },
        {
          kind: "done",
          output: {
            content: [{ kind: "text", text: "wrong" }],
            stopReason: "completed",
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
          },
        },
      ];
      const current = await runEval({
        name: "reg",
        tasks: [mkTask("t1", "ok", [exactMatch()]), mkTask("t2-new", "ok", [exactMatch()])],
        agentFactory: ((seq) => () => {
          const events = seq.shift() ?? [];
          return fakeAgent(events);
        })([[{ kind: "text_delta", delta: "ok" }, doneEvent] as EngineEvent[], partial]),
        idGen: () => "cur",
      });
      const result = compareRuns(baseline, current);
      log(
        "regression flags new degraded task (strict bar)",
        result.kind === "fail" && result.regressions.some((reg) => reg.taskId === "t2-new"),
      );
    }

    // ------------------------------------------------------------------
    // 12. Self-test: AbortError-rejecting check is confirmed
    // ------------------------------------------------------------------
    {
      let secondRan = false;
      const result = await runSelfTest([
        {
          name: "abort-error",
          run: (signal) =>
            new Promise<{ pass: true }>((_, reject) => {
              signal.addEventListener("abort", () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
              });
            }),
          timeoutMs: 10,
        },
        {
          name: "after",
          run: () => {
            secondRan = true;
            return { pass: true };
          },
        },
      ]);
      log(
        "self-test accepts AbortError as confirmed",
        result.checks[0]?.cancellation === "confirmed" && secondRan,
      );
    }

    // ------------------------------------------------------------------
    // 13. Self-test: unrelated rejection after timeout is unconfirmed
    // ------------------------------------------------------------------
    {
      let secondRan = false;
      const result = await runSelfTest([
        {
          name: "unrelated",
          run: () =>
            new Promise<{ pass: true }>((_, reject) => {
              setTimeout(() => reject(new Error("network down")), 30);
            }),
          timeoutMs: 10,
        },
        {
          name: "after",
          run: () => {
            secondRan = true;
            return { pass: true };
          },
        },
      ]);
      log(
        "self-test stops on unrelated post-timeout rejection",
        result.checks[0]?.cancellation === "unconfirmed" && !secondRan,
      );
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
