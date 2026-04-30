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
  const configFingerprint = `order=${order};calls=${stableStringify(fallbackCalls)}`;
  return {
    id,
    configFingerprint,
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

/**
 * Collect tool calls that actually completed. A `tool_call_start` alone
 * indicates intent — the tool may have been denied, aborted, or failed
 * before yielding output. Requiring a matching `tool_result` (correlated
 * by callId) prevents the grader from passing on intent alone.
 */
function collectToolCalls(transcript: readonly EngineEvent[]): readonly ObservedCall[] {
  const startsByCallId = new Map<string, ObservedCall>();
  const completed = new Set<string>();
  for (const ev of transcript) {
    if (ev.kind === "tool_call_start") {
      startsByCallId.set(ev.callId, { toolName: ev.toolName, args: ev.args });
    } else if (ev.kind === "tool_result") {
      // Only `tool_result` proves the tool actually executed.
      // `tool_call_end` is only the end of streaming accumulation.
      completed.add(ev.callId);
    }
  }
  const out: ObservedCall[] = [];
  for (const [callId, call] of startsByCallId) {
    if (completed.has(callId)) out.push(call);
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
  return subsetMatches(expected.args, observed.args ?? {});
}

/**
 * Recursive subset match: `want` is satisfied by `have` if every key in
 * `want` matches a value in `have`. For objects, the same rule applies
 * recursively — extra keys in `have` are allowed at every depth. Arrays
 * still require exact length and element equality (positional semantics).
 *
 * This makes evals stable under additive tool-schema changes: a new
 * optional nested field on the tool's args won't break existing
 * expectations as long as the required values still match.
 */
function subsetMatches(want: unknown, have: unknown): boolean {
  if (Object.is(want, have)) return true;
  if (want === null || have === null) return false;
  if (typeof want !== "object" || typeof have !== "object") return false;
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || want.length !== have.length) return false;
    for (let i = 0; i < want.length; i++) {
      if (!subsetMatches(want[i], have[i])) return false;
    }
    return true;
  }
  if (Array.isArray(have)) return false;
  const wObj = want as Readonly<Record<string, unknown>>;
  const hObj = have as Readonly<Record<string, unknown>>;
  for (const k of Object.keys(wObj)) {
    if (!subsetMatches(wObj[k], hObj[k])) return false;
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

function stableStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
