import type { AgentId } from "@koi/core";

/**
 * One span in a turn trace. Recursive: a span owns its children.
 * `category` mirrors the L1 trace taxonomy (model, tool, mw, hook, channel, custom).
 */
export interface TraceSpan {
  readonly spanId: string;
  readonly name: string;
  /**
   * Known v1 categories are `model | tool | mw | hook | channel | custom`.
   * Forward-compat: newer servers may emit additional kinds; the escape
   * hatch keeps that string assignable while preserving IntelliSense.
   */
  readonly category: "model" | "tool" | "mw" | "hook" | "channel" | "custom" | (string & {});
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly children: readonly TraceSpan[];
}

/**
 * Full trace for one turn — the data behind a single TraceView UI panel.
 * `root` is a synthetic frame whose children are the actual top-level spans.
 */
export interface TraceView {
  readonly turnId: string;
  readonly agentId: AgentId;
  readonly turnIndex: number;
  readonly startedAtMs: number;
  readonly totalDurationMs: number;
  readonly root: TraceSpan;
}
