/** Iterative deep-freeze. Cycle-safe via WeakSet. */
export function deepFreeze(root: unknown): void {
  if (root === null || typeof root !== "object") return;
  const seen = new WeakSet<object>();
  const worklist: unknown[] = [root];
  while (worklist.length > 0) {
    const obj = worklist.pop();
    if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) continue;
    if (seen.has(obj)) continue;
    seen.add(obj);
    Object.freeze(obj);
    const values = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of values) {
      worklist.push(v);
    }
  }
}
