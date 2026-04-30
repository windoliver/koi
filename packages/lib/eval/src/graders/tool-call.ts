import type { EngineEvent, JsonObject } from "@koi/core";
import type { EvalExpectation, EvalGrader, EvalScore, ExpectedToolCall } from "../types.js";

export interface ToolCallOptions {
  readonly id?: string | undefined;
  readonly calls?: readonly ExpectedToolCall[] | undefined;
  readonly order?: "strict" | "any" | undefined;
  /**
   * When true, count `tool_call_end` as a completion signal in addition
   * to `tool_result`. Use this only for transcript sources that don't
   * emit `tool_result` (some cassette/replay formats). Default false:
   * `tool_result` is the engine's authoritative completion signal —
   * `tool_call_end` only marks the model finishing the call argument
   * stream, before execution.
   */
  readonly acceptToolCallEnd?: boolean | undefined;
  /**
   * When true, allow the transcript to contain completed tool calls
   * beyond the expected set. Default false: extra calls fail the grader
   * because the whole point of `toolCall` is catching surprise
   * side-effecting tool activity (e.g., expected `read` but observed
   * `read + delete`). Permissive matching is opt-in for the rare case
   * where the eval only cares that *at least* the expected calls fired.
   */
  readonly allowExtra?: boolean | undefined;
}

const DEFAULT_ID = "tool-call";

export function toolCall(options: ToolCallOptions = {}): EvalGrader {
  const id = options.id ?? DEFAULT_ID;
  const fallbackCalls = options.calls;
  const order = options.order ?? "any";
  const acceptToolCallEnd = options.acceptToolCallEnd ?? false;
  const allowExtra = options.allowExtra ?? false;
  const configFingerprint = `order=${order};acceptToolCallEnd=${acceptToolCallEnd};allowExtra=${allowExtra};calls=${stableStringify(fallbackCalls)}`;
  return {
    id,
    configFingerprint,
    grade: (transcript, expected): EvalScore => {
      const calls = resolveCalls(expected, fallbackCalls);
      if (calls === undefined || calls.length === 0) {
        return { graderId: id, score: 0, pass: false, reasoning: "no tool_calls expectation" };
      }
      const observed = collectToolCalls(transcript, acceptToolCallEnd);
      const matched = order === "strict" ? matchStrict(observed, calls) : matchAny(observed, calls);
      const allMatched = matched.length === calls.length;
      // Strict mode already enforces an exact-sequence match (no extras
      // possible). For any-order, fail on observed > expected unless the
      // caller opts in via `allowExtra`. Otherwise an expected `read`
      // would still pass when the agent also performed a destructive
      // `delete` — exactly the regression this grader exists to catch.
      const extraCount = order === "strict" ? 0 : Math.max(0, observed.length - calls.length);
      const hasUnexpectedExtra = !allowExtra && extraCount > 0;
      const pass = allMatched && !hasUnexpectedExtra;
      const score = matched.length / calls.length;
      const reasoning = pass
        ? `matched ${matched.length}/${calls.length}`
        : !allMatched
          ? `matched ${matched.length}/${calls.length} (missing: ${missing(calls, matched).join(", ")})`
          : `matched ${matched.length}/${calls.length} but observed ${extraCount} unexpected extra tool call(s); set allowExtra: true to permit`;
      return { graderId: id, score, pass, reasoning };
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
 * before yielding output. Either `tool_result` or `tool_call_end`
 * (correlated by callId) proves the tool finished executing; engine
 * producers in this repo emit one or both, depending on the stream
 * source. Accept both so evals work against any valid transcript.
 */
function collectToolCalls(
  transcript: readonly EngineEvent[],
  acceptToolCallEnd: boolean,
): readonly ObservedCall[] {
  // Order-aware: a completion only counts if it followed a matching start
  // for the same callId, and a callId can only complete once. This rejects
  // out-of-order completions (completion before start) and stale repeat
  // completions that would otherwise let the grader pass on garbage.
  //
  // Default: only `tool_result` proves the tool actually executed.
  // `tool_call_end` is the model finishing the call-arg stream BEFORE
  // execution; counting it would let denied/failed/aborted calls pass.
  // Opt in via `acceptToolCallEnd` for replay sources that don't emit
  // `tool_result`.
  const pending = new Map<string, ObservedCall>();
  const out: ObservedCall[] = [];
  for (const ev of transcript) {
    if (ev.kind === "tool_call_start") {
      pending.set(ev.callId, { toolName: ev.toolName, args: ev.args });
    } else if (ev.kind === "tool_result" || (acceptToolCallEnd && ev.kind === "tool_call_end")) {
      const start = pending.get(ev.callId);
      if (start === undefined) continue;
      out.push(start);
      pending.delete(ev.callId);
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
  // Exact sequence: observed must equal expected in length and at every
  // position. Any unexpected interleaved call (e.g. `read → delete → write`
  // when expecting `read → write`) is a hard fail. This is the safe
  // default for guarding against extra side-effecting tool activity.
  if (observed.length !== expected.length) return [];
  const matched: ExpectedToolCall[] = [];
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    const got = observed[i];
    if (want === undefined || got === undefined) return [];
    if (!callMatches(got, want)) return [];
    matched.push(want);
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
