/**
 * Topology-aware canonical encoder for the artifact-side cache key.
 * Extracted from pipeline.ts in R37 to keep pipeline.ts under the
 * 800-line hard limit; semantics unchanged.
 */

/**
 * Hard caps on artifact graph traversal. Both `rejectUnsupportedShape`
 * and `canonicalJson` recurse synchronously over attacker-controlled
 * input; an abort signal cannot interrupt synchronous JS, so the only
 * way to bound preprocessing CPU under cancellation pressure is to bound
 * the input itself.
 *
 *   - DEPTH (256): catches stack-blowing inputs; safely below V8's default
 *     call-stack limit while exceeding any realistic config artifact.
 *   - NODES (50_000): catches wide flat inputs (e.g. an array/object with
 *     1M entries) that the depth cap alone cannot stop. Counts every
 *     visited primitive AND every container so the bound is total work,
 *     not just leaf work.
 */
export const MAX_ARTIFACT_DEPTH = 256;
export const MAX_ARTIFACT_NODES = 50_000;

export interface NodeBudget {
  count: number;
}

export interface CanonicalState {
  readonly onStack: WeakSet<object>;
  readonly seen: WeakMap<object, number>;
  readonly budget: NodeBudget;
  refCounter: number;
}

/**
 * Encode a primitive leaf for the canonical key. JSON.stringify is not
 * injective for JS values:
 *   - NaN / ±Infinity all serialize to "null"
 *   - -0 serializes to "0"
 *   - undefined yields literal undefined (string-concat hazard)
 *   - bigint throws
 *
 * Bare-string sentinels like `"#NaN"` would collide with user strings of
 * the same content. Every leaf instead gets a TYPE TAG prefix unique to
 * its JS type — `s:`, `f:`, `b:`, `n:`, `u:`, `g:` — so the encoded
 * string for a value of one type can never equal the encoded string for
 * a value of any other type. Arrays/objects retain their `[`/`{` prefix
 * and never start with a tag, so they are distinguishable too.
 */
function encodePrimitive(value: unknown): string {
  if (value === null) return "n:";
  if (value === undefined) return "u:";
  if (typeof value === "boolean") return value ? "b:t" : "b:f";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "f:NaN";
    if (value === Number.POSITIVE_INFINITY) return "f:+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "f:-Inf";
    if (Object.is(value, -0)) return "f:-0";
    return `f:${value}`;
  }
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "bigint") return `g:${value.toString()}`;
  // Symbols/functions cannot reach here — rejectUnsupportedShape rejects
  // them upstream — but keep a defensive tag rather than fall through.
  return `?:${JSON.stringify(String(value))}`;
}

/**
 * Topology-aware canonical serializer. Tracks two things:
 *
 *   - `onStack`: ancestors of the current node — a re-entry is a TRUE
 *     cycle and throws (no deterministic linearization exists).
 *   - `seen`: every previously-visited object → integer ID. Re-encountering
 *     a shared subobject (DAG aliasing) emits `ref:N` instead of recursing.
 *     This makes shared-reference DAGs cacheable AND distinct from
 *     identical-content non-shared graphs: stages observe reference
 *     identity (`a.x === a.y`), so the cached pass is bound to topology.
 */
export function canonicalJson(value: unknown, state: CanonicalState, depth = 0): string {
  if (depth > MAX_ARTIFACT_DEPTH) {
    throw new Error(`snapshot exceeds maximum depth (${MAX_ARTIFACT_DEPTH})`);
  }
  state.budget.count += 1;
  if (state.budget.count > MAX_ARTIFACT_NODES) {
    throw new Error(`snapshot exceeds maximum node count (${MAX_ARTIFACT_NODES})`);
  }
  if (value === null || typeof value !== "object") return encodePrimitive(value);
  if (state.onStack.has(value)) {
    const err = new Error("snapshot contains a cycle; cannot derive a deterministic cache key");
    (err as Error & { code?: string }).code = "FORGE_VERIFIER_CYCLE";
    throw err;
  }
  const priorId = state.seen.get(value);
  if (priorId !== undefined) {
    return `ref:${priorId}`;
  }
  const id = state.refCounter++;
  state.seen.set(value, id);
  state.onStack.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        parts.push(canonicalJson(value[i], state, depth + 1));
      }
      return `#${id}[${parts.join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], state, depth + 1)}`,
    );
    return `#${id}{${parts.join(",")}}`;
  } finally {
    state.onStack.delete(value);
  }
}
