import type { EngineEvent, JsonObject } from "@koi/core";
import type { EvalExpectation, EvalGrader, EvalScore, ExpectedToolCall } from "../types.js";

export interface ToolCallOptions {
  readonly id?: string | undefined;
  readonly calls?: readonly ExpectedToolCall[] | undefined;
  readonly order?: "strict" | "any" | undefined;
}

const DEFAULT_ID = "tool-call";

export function toolCall(options: ToolCallOptions = {}): EvalGrader {
  const id = options.id ?? DEFAULT_ID;
  const fallbackCalls = options.calls;
  const order = options.order ?? "any";
  return {
    id,
    grade: (transcript, expected): EvalScore => {
      const calls = resolveCalls(expected, fallbackCalls);
      if (calls === undefined || calls.length === 0) {
        return { graderId: id, score: 0, pass: false, reasoning: "no tool_calls expectation" };
      }
      const observed = collectToolCalls(transcript);
      const matched = order === "strict" ? matchStrict(observed, calls) : matchAny(observed, calls);
      const score = matched.length / calls.length;
      const pass = matched.length === calls.length;
      return {
        graderId: id,
        score,
        pass,
        reasoning: pass
          ? `matched ${matched.length}/${calls.length}`
          : `matched ${matched.length}/${calls.length} (missing: ${missing(calls, matched).join(", ")})`,
      };
    },
  };
}

interface ObservedCall {
  readonly toolName: string;
  readonly args: JsonObject | undefined;
}

function collectToolCalls(transcript: readonly EngineEvent[]): readonly ObservedCall[] {
  const out: ObservedCall[] = [];
  for (const ev of transcript) {
    if (ev.kind === "tool_call_start") {
      out.push({ toolName: ev.toolName, args: ev.args });
    }
  }
  return out;
}

function resolveCalls(
  expected: EvalExpectation | undefined,
  fallback: readonly ExpectedToolCall[] | undefined,
): readonly ExpectedToolCall[] | undefined {
  if (expected !== undefined && expected.kind === "tool_calls") return expected.calls;
  return fallback;
}

function callMatches(observed: ObservedCall, expected: ExpectedToolCall): boolean {
  if (observed.toolName !== expected.toolName) return false;
  if (expected.args === undefined) return true;
  return shallowSubset(expected.args, observed.args ?? {});
}

function shallowSubset(want: Readonly<Record<string, unknown>>, have: JsonObject): boolean {
  for (const key of Object.keys(want)) {
    if (!Object.is(want[key], have[key])) return false;
  }
  return true;
}

function matchAny(
  observed: readonly ObservedCall[],
  expected: readonly ExpectedToolCall[],
): readonly ExpectedToolCall[] {
  const usedIndices = new Set<number>();
  const matched: ExpectedToolCall[] = [];
  for (const want of expected) {
    const idx = observed.findIndex((o, i) => !usedIndices.has(i) && callMatches(o, want));
    if (idx >= 0) {
      usedIndices.add(idx);
      matched.push(want);
    }
  }
  return matched;
}

function matchStrict(
  observed: readonly ObservedCall[],
  expected: readonly ExpectedToolCall[],
): readonly ExpectedToolCall[] {
  const matched: ExpectedToolCall[] = [];
  let cursor = 0;
  for (const want of expected) {
    while (cursor < observed.length) {
      const o = observed[cursor];
      cursor += 1;
      if (o !== undefined && callMatches(o, want)) {
        matched.push(want);
        break;
      }
    }
  }
  return matched;
}

function missing(
  expected: readonly ExpectedToolCall[],
  matched: readonly ExpectedToolCall[],
): readonly string[] {
  const matchedSet = new Set(matched);
  return expected.filter((e) => !matchedSet.has(e)).map((e) => e.toolName);
}
