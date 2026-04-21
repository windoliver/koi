/**
 * Transpile TypeScript source intended as a script body (top-level `return`
 * and `await` valid) to a self-contained async function expression in JavaScript.
 *
 * Strategy:
 * 1. Wrap the user code in `export default (async function(tools) { ... })`
 *    — the `export default` prevents the transpiler from eliding the expression,
 *    and the function wrapper makes top-level `return` valid.
 * 2. Strip the `export default` prefix so the result is a bare function expression
 *    that can be passed to `eval()` in the worker.
 *
 * Constraint: the user code must not contain import/export statements (they are
 * illegal inside function bodies).
 */
export function transpileTs(source: string): string {
  const wrapped = `export default (async function(tools: unknown) {\n${source}\n})`;
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const transpiled = transpiler.transformSync(wrapped);
  // Strip the module syntax so the result can be used with eval()
  return transpiled.replace(/^export default\s+/, "").trimEnd();
}
