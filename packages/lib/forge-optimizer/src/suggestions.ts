/**
 * Optimization suggestions — advisory only.
 *
 * `suggestMerge` proposes consolidating artifacts that have the same
 * (kind, normalized name, normalized description). Similarity is
 * intentionally an exact-match check on a normalized form: false
 * positives waste reviewer time. `suggestSimplify` flags composite
 * artifacts whose pipeline can collapse.
 */

import type { BrickArtifact, BrickId, BrickKind, CompositeArtifact } from "@koi/core";

export interface MergeSuggestion {
  readonly kind: "merge";
  readonly brickIds: readonly BrickId[];
  readonly reason: string;
}

export interface SimplifySuggestion {
  readonly kind: "simplify";
  readonly brickId: BrickId;
  readonly reason: string;
}

/**
 * Per-brick failure surfaced by `suggestMerge`. A non-JSON-safe artifact
 * (cyclic schema, BigInt, unserializable provenance) cannot be grouped,
 * so it is excluded from merge candidates AND reported here so operators
 * can route it to a quarantine / repair pipeline. Silently dropping the
 * bad brick would hide exactly the artifact that needs attention.
 */
export interface MergeSkipped {
  readonly kind: "skipped";
  readonly brickId: BrickId;
  readonly reason: string;
}

export interface MergeResult {
  readonly suggestions: readonly MergeSuggestion[];
  readonly skipped: readonly MergeSkipped[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Group only artifacts that share the same trust domain. Crossing scope,
 * origin, lifecycle, or namespace boundaries would suggest consolidating
 * (for example) a quarantined community brick with an active operator
 * brick — a real risk because callers act on these suggestions.
 */
/**
 * Kind-specific behavior fields that determine whether two bricks of the
 * same kind are actually interchangeable. Same labels + different
 * implementation / schema / steps → the merge suggestion would be wrong.
 */
function kindContract(brick: BrickArtifact): unknown {
  switch (brick.kind) {
    case "tool":
      return [brick.implementation, brick.inputSchema, brick.outputSchema ?? null];
    case "skill":
      return [brick.content];
    case "agent":
      return [brick.manifestYaml];
    case "middleware":
    case "channel":
      return [brick.implementation];
    case "composite":
      return [
        brick.steps.map((s) => [s.brickId, s.inputPort, s.outputPort]),
        brick.exposedInput,
        brick.exposedOutput,
        brick.outputKind,
      ];
  }
}

/**
 * Stable JSON encoding for objects whose key insertion order is not
 * guaranteed by producers. Two structurally-equal records must encode
 * identically so they group together; differing keys/values must encode
 * differently so non-equivalent bricks do not collapse.
 */
function encodeStable(value: Readonly<Record<string, unknown>> | undefined | null): string {
  if (value === undefined || value === null) return "null";
  const keys = Object.keys(value).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = value[k];
  return JSON.stringify(sorted);
}

/**
 * Behavior-bearing fields outside `kindContract` that affect discovery
 * and runtime behavior. Two bricks with identical kind contract but
 * differing trigger patterns, companion files, configSchema, or drift
 * source mapping are NOT interchangeable — merging them would collapse
 * distinct activation paths or required assets.
 */
function behaviorContract(brick: BrickArtifact): unknown {
  return [
    [...(brick.trigger ?? [])].sort(),
    encodeStable(brick.files ?? null),
    encodeStable(brick.configSchema ?? null),
    brick.driftContext ?? null,
  ];
}

function groupKey(brick: BrickArtifact): string {
  // JSON-encode each field separately so a space inside `name` cannot
  // collide with a space-joined boundary (e.g. name="a b"+desc="c" must
  // not key-equal name="a"+desc="b c").
  //
  // The key includes everything that determines whether two bricks are
  // actually interchangeable: trust + policy + requires (privilege),
  // kind-specific contract (behavior), plus human labels (what the
  // suggestion is about). Anything less risks merging across trust
  // boundaries or collapsing distinct implementations.
  return JSON.stringify([
    brick.kind,
    brick.scope,
    brick.origin,
    brick.lifecycle,
    brick.namespace ?? "",
    brick.trustTier ?? "",
    brick.signature ?? null,
    brick.policy,
    brick.requires ?? null,
    // version + provenance: two same-content artifacts with different
    // release versions or different source lineage are intentionally
    // distinct (rollback target, migration boundary, audit traceability).
    // Excluding these would let the merge advice drive irreversible
    // state loss when callers auto-apply.
    brick.version,
    brick.provenance,
    kindContract(brick),
    // Behavior-bearing base fields — see `behaviorContract`. Excluding any
    // of these would collapse distinct activation paths (trigger), required
    // assets (files), instantiation contracts (configSchema), or source
    // lineage (driftContext) into a single merge candidate.
    behaviorContract(brick),
    normalize(brick.name),
    normalize(brick.description),
  ]);
}

export function suggestMerge(bricks: readonly BrickArtifact[]): MergeResult {
  const groups = new Map<string, { kind: BrickKind; name: string; ids: BrickId[] }>();
  const skipped: MergeSkipped[] = [];
  for (const brick of bricks) {
    // Isolate per-brick failures: a single non-JSON-safe artifact (cyclic
    // schema, BigInt, unserializable provenance metadata) would otherwise
    // throw out of `JSON.stringify` in `groupKey` and abort the entire
    // advisory sweep. Surface the failure as a `skipped` entry so the
    // bad brick is visible to operators (silently dropping it would hide
    // exactly the artifact that needs cleanup).
    let key: string;
    try {
      key = groupKey(brick);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      skipped.push({
        kind: "skipped",
        brickId: brick.id,
        reason: `groupKey serialization failed: ${reason}`,
      });
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { kind: brick.kind, name: brick.name, ids: [brick.id] });
    } else {
      existing.ids.push(brick.id);
    }
  }
  const suggestions: MergeSuggestion[] = [];
  for (const group of groups.values()) {
    if (group.ids.length < 2) continue;
    suggestions.push({
      kind: "merge",
      brickIds: group.ids,
      reason: `${String(group.ids.length)} ${group.kind} bricks share the name "${group.name}" and description — consider merging`,
    });
  }
  return { suggestions, skipped };
}

function isComposite(brick: BrickArtifact): brick is CompositeArtifact {
  return brick.kind === "composite";
}

/**
 * Stable JSON encoding of a BrickPort — sorts the schema's top-level keys
 * so two structurally-equal ports compare equal regardless of property
 * insertion order. Deeper schema differences still register as a mismatch.
 */
function encodePort(port: {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}): string {
  const keys = Object.keys(port.schema).sort();
  const sortedSchema: Record<string, unknown> = {};
  for (const k of keys) sortedSchema[k] = port.schema[k];
  return JSON.stringify({ name: port.name, schema: sortedSchema });
}

function portsEqual(
  a: { readonly name: string; readonly schema: Readonly<Record<string, unknown>> },
  b: { readonly name: string; readonly schema: Readonly<Record<string, unknown>> },
): boolean {
  // `encodePort` JSON-stringifies the schema; a cyclic / non-JSON-safe
  // schema would otherwise throw and abort `suggestSimplify` for the
  // whole batch. Non-equivalent encoding is the safe answer when one
  // side fails to serialize (a corrupt schema is intentionally NOT
  // interchangeable with anything).
  let ea: string;
  let eb: string;
  try {
    ea = encodePort(a);
  } catch {
    return false;
  }
  try {
    eb = encodePort(b);
  } catch {
    return false;
  }
  return ea === eb;
}

export function suggestSimplify(brick: BrickArtifact): SimplifySuggestion | undefined {
  if (!isComposite(brick)) return undefined;
  if (brick.steps.length >= 2) return undefined;
  if (brick.steps.length === 0) {
    return {
      kind: "simplify",
      brickId: brick.id,
      reason: "Composite has zero steps — no pipeline; replace with a direct reference",
    };
  }
  // Single-step composite: only suggest collapse when the wrapper preserves
  // exactly the underlying step's I/O contract. A composite that exposes a
  // different port name or schema is intentionally narrowing/widening the
  // boundary and is NOT interchangeable with its inner brick.
  const step = brick.steps[0];
  if (step === undefined) return undefined;
  if (!portsEqual(brick.exposedInput, step.inputPort)) return undefined;
  if (!portsEqual(brick.exposedOutput, step.outputPort)) return undefined;
  return {
    kind: "simplify",
    brickId: brick.id,
    reason:
      "Composite has a single step and exposes the same I/O contract — collapse into the underlying brick",
  };
}
