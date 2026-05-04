/**
 * Artifact snapshot validation + deep freeze. Extracted from pipeline.ts
 * in R37 to keep pipeline.ts under the 800-line hard limit; semantics
 * unchanged.
 */

import { types } from "node:util";
import { MAX_ARTIFACT_DEPTH, MAX_ARTIFACT_NODES, type NodeBudget } from "./canonical.js";

/**
 * Reject artifacts that contain types whose mutability cannot be enforced by
 * `Object.freeze`, that introduce caller code on the verifier stack, or that
 * would silently lose information through `structuredClone`. Run BEFORE
 * `structuredClone` so the rejection is path-rooted (better error than what
 * structuredClone produces) and BEFORE traversal so a hostile getter never
 * fires.
 *
 * Specifically rejects:
 * - Map / Set: have mutating methods (`set`/`add`/`clear`) NOT covered by
 *   `Object.freeze`, so a frozen collection is still mutable at the API
 *   surface. Reject instead of pretending it's immutable.
 * - TypedArray / ArrayBuffer: same reasoning — `byteLength` and writes via
 *   index assignment bypass freeze.
 * - Proxy: traps execute caller code on the verifier stack — including in
 *   the validation routines themselves. Detected via privileged
 *   `node:util` `types.isProxy` so the check itself does NOT fire a trap.
 * - Accessor properties (getter/setter): same reason — invoking the
 *   accessor would run caller code; reject to keep the verifier
 *   side-effect free during validation.
 * - Non-enumerable / symbol-keyed own properties: `structuredClone` drops
 *   them, so the snapshot would not match what the caller passed in and
 *   the cached pass could attest to a different shape than the input.
 * - Sparse arrays (holes in [0, length)): JSON.stringify and other
 *   serializers SKIP holes, so a sparse array would alias to a denser one
 *   in the cache key — different content, same key.
 * - Class instances (non-plain objects): `structuredClone` silently strips
 *   the prototype, so stages would receive a plain-object that is not
 *   equal to what the caller passed in and the cached pass would attest
 *   to a different shape than the input.
 */
export function rejectUnsupportedShape(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  budget: NodeBudget,
  depth = 0,
): void {
  if (depth > MAX_ARTIFACT_DEPTH) {
    throw new TypeError(
      `Artifact at ${path} exceeds maximum depth (${MAX_ARTIFACT_DEPTH}); deeply-nested artifacts are rejected to bound preprocessing CPU under cancellation.`,
    );
  }
  budget.count += 1;
  if (budget.count > MAX_ARTIFACT_NODES) {
    throw new TypeError(
      `Artifact at ${path} exceeds maximum node count (${MAX_ARTIFACT_NODES}); wide artifacts are rejected to bound preprocessing CPU under cancellation.`,
    );
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(
        `Artifact at ${path} has unsupported type "${typeof value}"; verifier requires plain-data artifacts.`,
      );
    }
    return;
  }
  // Proxy detection BEFORE any reflective op. `types.isProxy` is a privileged
  // V8 introspection (Bun + Node both expose it via node:util) that does NOT
  // invoke any handler. A Proxy artifact is rejected here without ever firing
  // a trap, closing the only remaining caller-code-on-verifier-stack path.
  if (types.isProxy(value)) {
    throw new TypeError(
      `Artifact at ${path} is a Proxy; verifier requires plain-data artifacts (Proxy traps would execute caller code on the verifier stack).`,
    );
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set
  ) {
    throw new TypeError(
      `Artifact at ${path} contains ${value.constructor.name}; verifier requires plain-data artifacts (Map/Set/typed-array unsupported).`,
    );
  }
  if (Array.isArray(value)) {
    rejectArrayShape(value, path, seen, budget, depth);
    return;
  }
  rejectObjectShape(value, path, seen, budget, depth);
}

function rejectArrayShape(
  value: readonly unknown[],
  path: string,
  seen: WeakSet<object>,
  budget: NodeBudget,
  depth: number,
): void {
  const arrSymbols = Object.getOwnPropertySymbols(value);
  if (arrSymbols.length > 0) {
    throw new TypeError(
      `Artifact at ${path} (array) has symbol-keyed own properties; verifier requires plain-data artifacts.`,
    );
  }
  // Charge the array's declared length toward the budget BEFORE any
  // hole scan. Without this, `new Array(1_000_000_000)` forces an
  // O(length) synchronous scan even though the budget should reject
  // it instantly.
  budget.count += value.length;
  if (budget.count > MAX_ARTIFACT_NODES) {
    throw new TypeError(
      `Artifact at ${path} declares length=${value.length} which alone exceeds the maximum node count (${MAX_ARTIFACT_NODES}); arrays are bounded by their declared length to prevent CPU exhaustion before any hole scan.`,
    );
  }
  const arrDescs = Object.getOwnPropertyDescriptors(value);
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(arrDescs, String(i))) {
      throw new TypeError(
        `Artifact at ${path}[${i}] is a hole; verifier rejects sparse arrays (holes are skipped by serializers and would alias dense arrays in the cache key).`,
      );
    }
  }
  for (const [k, desc] of Object.entries(arrDescs)) {
    if (k === "length") continue;
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      throw new TypeError(
        `Artifact at ${path}.${k} (array property) is an accessor (getter/setter); verifier rejects accessors so caller code never executes during validation.`,
      );
    }
    if (desc.enumerable !== true) {
      throw new TypeError(
        `Artifact at ${path}.${k} (array property) is non-enumerable; verifier requires plain-data artifacts.`,
      );
    }
    if (!/^\d+$/.test(k)) {
      throw new TypeError(
        `Artifact at ${path}.${k} (array property) is a non-index own property; verifier requires plain-data arrays (extra named properties are not preserved by structuredClone).`,
      );
    }
    rejectUnsupportedShape(desc.value, `${path}[${k}]`, seen, budget, depth + 1);
  }
}

function rejectObjectShape(
  value: object,
  path: string,
  seen: WeakSet<object>,
  budget: NodeBudget,
  depth: number,
): void {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `Artifact at ${path} is a non-plain object (${proto.constructor.name}); verifier requires plain-data artifacts.`,
    );
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new TypeError(
      `Artifact at ${path} has symbol-keyed own properties; verifier requires plain-data artifacts (symbol keys are not preserved by structuredClone).`,
    );
  }
  // Preflight key count BEFORE materializing every descriptor — a
  // wide attacker-controlled object would otherwise force a full
  // O(n) descriptor allocation prior to the budget check.
  const keys = Object.getOwnPropertyNames(value);
  budget.count += keys.length;
  if (budget.count > MAX_ARTIFACT_NODES) {
    throw new TypeError(
      `Artifact at ${path} has ${keys.length} own keys which alone exceeds the maximum node count (${MAX_ARTIFACT_NODES}); wide objects are bounded before descriptor materialization to prevent CPU exhaustion.`,
    );
  }
  for (const k of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, k);
    if (desc === undefined) continue;
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      throw new TypeError(
        `Artifact at ${path}.${k} is an accessor (getter/setter); verifier rejects accessors so caller code never executes during validation.`,
      );
    }
    if (desc.enumerable !== true) {
      throw new TypeError(
        `Artifact at ${path}.${k} is non-enumerable; verifier requires plain-data artifacts (non-enumerable properties are not preserved by structuredClone).`,
      );
    }
    rejectUnsupportedShape(desc.value, `${path}.${k}`, seen, budget, depth + 1);
  }
}

/**
 * Recursively freeze plain objects and arrays. Map/Set/typed arrays are
 * rejected upstream by `rejectUnsupportedShape`, so we never reach them here.
 * Already-frozen substructures are skipped to avoid redundant work.
 */
export function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return;
  }
  for (const v of Object.values(value)) deepFreeze(v);
}
