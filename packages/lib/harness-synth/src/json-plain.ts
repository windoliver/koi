/**
 * JSON-plain validation and cloning helpers for the synthesis trust
 * boundaries. Used at every public-API edge that ingests caller-supplied
 * values (target schemas, verifier summaries, etc.) so the loop never
 * carries hostile getters, BigInt, NaN/Infinity, cycles, or non-plain
 * prototypes past the boundary.
 */

/**
 * Maximum nesting depth accepted in any JSON-plain value. Values deeper
 * than this are rejected so the recursive helpers (ensureJsonPlain,
 * deepFreeze, jsonEqual) cannot blow the call stack on adversarial input.
 * 64 is well past any realistic JSON Schema and below the engine's stack
 * cliff in every host we target.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Single-pass clone-and-validate. Reads each property exactly once and
 * either returns a deep-cloned JSON-plain value or a typed failure
 * naming the first violation. Used at trust boundaries where two-pass
 * validate-then-snapshot would let a non-deterministic getter diverge
 * across reads, and where JSON.stringify+parse would silently normalize
 * undefined/NaN/Infinity instead of rejecting them.
 */
export function snapshotJsonPlain(
  value: unknown,
  label: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  const seen = new WeakSet<object>();
  return walk(value, label, 0);

  function walk(
    v: unknown,
    path: string,
    depth: number,
  ):
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly reason: string } {
    if (depth > MAX_JSON_DEPTH) {
      return { ok: false, reason: `${path} exceeds max nesting depth ${MAX_JSON_DEPTH}` };
    }
    if (v === null) return { ok: true, value: null };
    const t = typeof v;
    if (t === "string" || t === "boolean") return { ok: true, value: v };
    if (t === "number") {
      if (!Number.isFinite(v)) {
        return { ok: false, reason: `${path} contains non-finite number` };
      }
      return { ok: true, value: v };
    }
    if (t === "bigint") return { ok: false, reason: `${path} contains bigint` };
    if (t === "function") return { ok: false, reason: `${path} contains function` };
    if (t === "symbol") return { ok: false, reason: `${path} contains symbol` };
    if (t === "undefined") return { ok: false, reason: `${path} contains undefined` };
    if (t !== "object") return { ok: false, reason: `${path} contains non-JSON value` };
    const obj = v as object;
    if (seen.has(obj)) return { ok: false, reason: `${path} contains a cycle` };
    seen.add(obj);
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      for (let i = 0; i < obj.length; i += 1) {
        const r = walk(obj[i], `${path}[${i}]`, depth + 1);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, reason: `${path} is not a plain object literal` };
    }
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${path} key access threw: ${message}` };
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      let child: unknown;
      try {
        child = (obj as Record<string, unknown>)[k];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `${path}.${k} getter threw: ${message}` };
      }
      const r = walk(child, `${path}.${k}`, depth + 1);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
}

/**
 * Validation-only walk (no clone) for cases where we already hold a
 * trusted snapshot but want to re-verify plainness on a sub-path, or
 * for fast-path checks where allocation pressure matters.
 */
export function ensureJsonPlain(
  value: unknown,
  label: string,
): { ok: true } | { ok: false; reason: string } {
  const seen = new WeakSet<object>();
  return walk(value, label, 0);

  function walk(
    v: unknown,
    path: string,
    depth: number,
  ): { ok: true } | { ok: false; reason: string } {
    if (depth > MAX_JSON_DEPTH) {
      return { ok: false, reason: `${path} exceeds max nesting depth ${MAX_JSON_DEPTH}` };
    }
    if (v === null) return { ok: true };
    const t = typeof v;
    if (t === "string" || t === "boolean") return { ok: true };
    if (t === "number") {
      if (!Number.isFinite(v)) {
        return { ok: false, reason: `${path} contains non-finite number` };
      }
      return { ok: true };
    }
    if (t === "bigint") return { ok: false, reason: `${path} contains bigint` };
    if (t === "function") return { ok: false, reason: `${path} contains function` };
    if (t === "symbol") return { ok: false, reason: `${path} contains symbol` };
    if (t === "undefined") return { ok: false, reason: `${path} contains undefined` };
    if (t !== "object") return { ok: false, reason: `${path} contains non-JSON value` };
    const obj = v as object;
    if (seen.has(obj)) return { ok: false, reason: `${path} contains a cycle` };
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i += 1) {
        const r = walk(obj[i], `${path}[${i}]`, depth + 1);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, reason: `${path} is not a plain object literal` };
    }
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${path} key access threw: ${message}` };
    }
    for (const k of keys) {
      let child: unknown;
      try {
        child = (obj as Record<string, unknown>)[k];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `${path}.${k} getter threw: ${message}` };
      }
      const r = walk(child, `${path}.${k}`, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
}

/**
 * Structural equality for JSON-plain values. Key-order independent for
 * objects. Bounded by MAX_JSON_DEPTH so adversarial input cannot blow
 * the call stack.
 */
export function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false; // bound stack; caller fails closed
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!jsonEqual(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    const k = aKeys[i] as string;
    if (!jsonEqual(aObj[k], bObj[k], depth + 1)) return false;
  }
  return true;
}

/**
 * Recursively freeze a JSON-plain value so callers cannot mutate it
 * after we've snapshotted it for use. Bounded depth — inputs are
 * pre-validated by snapshotJsonPlain or ensureJsonPlain, so this path
 * is defense-in-depth.
 */
export function deepFreeze<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_JSON_DEPTH) {
    Object.freeze(value);
    return value;
  }
  for (const key of Object.keys(value as object)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, depth + 1);
  }
  Object.freeze(value);
  return value;
}
