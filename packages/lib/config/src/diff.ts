/**
 * Structural diff between two config snapshots.
 *
 * Used by ConfigManager.reload() to determine which fields changed, so that
 * classification, telemetry, and consumer notifications can carry a precise
 * changed-paths list.
 *
 * Semantics:
 * - Plain objects are walked recursively; each differing key yields a dot-path.
 * - Arrays are compared by structural equality as a whole — if any element or
 *   the length differs, the array's path is reported (no per-element diff).
 *   This matches @koi/config deep-merge semantics where arrays replace wholesale.
 * - Primitives compared with Object.is (handles NaN and -0 correctly).
 * - Keys existing on only one side are reported.
 * - Returns a deduplicated, lexicographically sorted list of dot-paths.
 */

export type ChangedPath = string;

export function diffConfig(prev: unknown, next: unknown): readonly ChangedPath[] {
  const paths = new Set<string>();
  walk(prev, next, "", paths);
  return [...paths].sort();
}

function walk(prev: unknown, next: unknown, path: string, out: Set<string>): void {
  if (Object.is(prev, next)) {
    return;
  }
  if (!isPlainObject(prev) || !isPlainObject(next)) {
    // One side is primitive / array / null / class — report this node as changed.
    if (!deepEqual(prev, next)) {
      out.add(path || "");
    }
    return;
  }
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const a = (prev as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    walk(a, b, childPath, out);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}
