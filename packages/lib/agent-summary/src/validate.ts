import { z } from "zod";
import type { SessionId, SkippedTranscriptEntry, SummaryOk } from "./types.js";

export interface ExpectedEnvelopeContext {
  readonly expectedHash: string;
  readonly expectedSessionId: SessionId;
  readonly expectedFromTurn: number;
  readonly expectedToTurn: number;
  readonly expectedKind: "clean" | "degraded" | "compacted";
  readonly expectedHasCompactionPrefix: boolean;
  readonly expectedRangeOrigin: "raw" | "post-compaction";
  readonly expectedSkipped: readonly SkippedTranscriptEntry[];
  readonly expectedDroppedTailTurns: number;
  readonly expectedCompactionEntryCount: number;
}

export type ValidateResult =
  | { readonly ok: true; readonly value: SummaryOk }
  | { readonly ok: false; readonly error: { readonly reason: string } };

function envelopeSchema() {
  const skipped = z.strictObject({
    lineNumber: z.number().int().nonnegative(),
    raw: z.string(),
    error: z.string(),
    reason: z.enum(["crash_artifact", "parse_error"]),
  });
  const action = z.strictObject({
    kind: z.enum(["tool_call", "edit", "decision"]),
    name: z.string(),
    paths: z.array(z.string()).optional(),
    detail: z.string().optional(),
  });
  const body = z.strictObject({
    sessionId: z.string(),
    range: z.strictObject({
      fromTurn: z.number().int().nonnegative(),
      toTurn: z.number().int().nonnegative(),
      entryCount: z.number().int().nonnegative(),
    }),
    goal: z.string(),
    status: z.enum(["succeeded", "partial", "failed"]),
    actions: z.array(action),
    outcomes: z.array(z.string()),
    errors: z.array(z.string()),
    learnings: z.array(z.string()),
    meta: z.strictObject({
      granularity: z.enum(["high", "medium", "detailed"]),
      modelHint: z.enum(["cheap", "default", "smart"]),
      hash: z.string(),
      generatedAt: z.number().int().nonnegative(),
      schemaVersion: z.literal(1),
      hasCompactionPrefix: z.boolean(),
      rangeOrigin: z.enum(["raw", "post-compaction"]),
    }),
  });
  return z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("clean"), summary: body }),
    z.strictObject({
      kind: z.literal("degraded"),
      partial: body,
      skipped: z.array(skipped).min(1),
      droppedTailTurns: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("compacted"),
      derived: body,
      compactionEntryCount: z.number().int().min(1),
      skipped: z.array(skipped),
      droppedTailTurns: z.number().int().nonnegative(),
    }),
  ]);
}

export function validateCachedEnvelope(
  cached: unknown,
  ctx: ExpectedEnvelopeContext,
): ValidateResult {
  const shape = envelopeSchema().safeParse(cached);
  if (!shape.success) {
    const first = shape.error.issues[0];
    return {
      ok: false,
      error: { reason: `shape_${first?.path.join(".") ?? "zod"}` },
    };
  }
  const env = shape.data;

  if (env.kind !== ctx.expectedKind) return fail("kind_mismatch");
  const body =
    env.kind === "clean" ? env.summary : env.kind === "degraded" ? env.partial : env.derived;
  if (body.sessionId !== ctx.expectedSessionId) return fail("id_mismatch");
  if (body.range.fromTurn !== ctx.expectedFromTurn || body.range.toTurn !== ctx.expectedToTurn)
    return fail("range_mismatch");
  if (body.meta.hash !== ctx.expectedHash) return fail("hash_mismatch");
  if (body.meta.hasCompactionPrefix !== ctx.expectedHasCompactionPrefix)
    return fail("compaction_flag_mismatch");
  if (body.meta.rangeOrigin !== ctx.expectedRangeOrigin) return fail("range_origin_mismatch");

  if (env.kind === "degraded" || env.kind === "compacted") {
    if (env.droppedTailTurns !== ctx.expectedDroppedTailTurns)
      return fail("dropped_turns_mismatch");
    if (!skippedEqual(env.skipped, ctx.expectedSkipped))
      return fail("skipped_fingerprint_mismatch");
  }
  if (env.kind === "compacted") {
    if (env.compactionEntryCount !== ctx.expectedCompactionEntryCount)
      return fail("compaction_count_mismatch");
  }
  // The schema parses sessionId as string; brand it back. Safe because identity
  // check above confirmed body.sessionId === ctx.expectedSessionId (branded).
  return { ok: true, value: env as unknown as SummaryOk };
}

function skippedEqual(
  a: readonly SkippedTranscriptEntry[],
  b: readonly SkippedTranscriptEntry[],
): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].toSorted((x, y) => x.lineNumber - y.lineNumber);
  const bb = [...b].toSorted((x, y) => x.lineNumber - y.lineNumber);
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i];
    const y = bb[i];
    if (!x || !y) return false;
    if (
      x.lineNumber !== y.lineNumber ||
      x.reason !== y.reason ||
      x.raw !== y.raw ||
      x.error !== y.error
    )
      return false;
  }
  return true;
}

function fail(reason: string): ValidateResult {
  return { ok: false, error: { reason } };
}
