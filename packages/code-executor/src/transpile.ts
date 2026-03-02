/**
 * TypeScript → JavaScript transpiler using Bun's built-in transpiler.
 *
 * Strips type annotations, produces plain JavaScript. Zero external deps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranspileResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function transpileTs(code: string): TranspileResult {
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const js = transpiler.transformSync(code);
    return { ok: true, code: js };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "TypeScript transpilation failed";
    return { ok: false, error: message };
  }
}
