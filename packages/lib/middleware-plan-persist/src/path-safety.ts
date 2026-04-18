/**
 * Path-traversal guards for plan-file I/O.
 *
 * Any path the model can influence (slug, load `path`) must resolve to a
 * descendant of the configured `baseDir` after `realpath`. Symlinks that
 * escape are rejected, NUL bytes are rejected, `..` segments are rejected.
 *
 * Mirrors the prefix-check pattern in Claude Code's `getPlansDirectory()`.
 */

import { resolve, sep } from "node:path";

interface PathSafetyFs {
  readonly realpath: (path: string) => Promise<string>;
}

/**
 * Resolve `baseDir` against `cwd` and verify it lives under `cwd`. Returns
 * the absolute base path or an error. Called once at construction time so
 * a misconfigured `baseDir` fails fast.
 */
export function resolveBaseDir(
  baseDir: string,
  cwd: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  if (baseDir.includes("\u0000")) {
    return { ok: false, error: "baseDir contains NUL byte" };
  }
  const resolvedBase = resolve(cwd, baseDir);
  const resolvedCwd = resolve(cwd);
  if (resolvedBase !== resolvedCwd && !resolvedBase.startsWith(resolvedCwd + sep)) {
    return { ok: false, error: `baseDir must be within cwd: ${baseDir}` };
  }
  return { ok: true, path: resolvedBase };
}

/**
 * Resolve a model-supplied path and verify it lives under `baseDir`.
 *
 * The literal-prefix check uses `baseDir` (the user-configured value) so that
 * an obvious traversal like `/etc/passwd` is rejected without an fs hop.
 *
 * The realpath check then compares the canonical resolution of the candidate
 * against the canonical resolution of `baseDir` (`baseDirReal`). This is
 * required because on platforms where `/tmp` symlinks to `/private/tmp`
 * (macOS), realpath of any file under `baseDir` returns the canonical form
 * while `baseDir` itself is still the literal user value. Without resolving
 * both sides, a legitimate save+load round-trip would be incorrectly rejected.
 *
 * Returns `{ ok: false, error: "path outside baseDir" }` for traversal,
 * `{ ok: false, error: "file not found" }` when realpath fails.
 */
export async function resolveSafePath(
  candidate: string,
  baseDir: string,
  baseDirReal: string,
  cwd: string,
  fs: PathSafetyFs,
): Promise<
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }
> {
  if (candidate.includes("\u0000")) {
    return { ok: false, error: "path contains NUL byte" };
  }
  const literal = resolve(cwd, candidate);
  // Cheap literal-prefix check first — rejects obvious traversal without an fs hop.
  if (
    literal !== baseDir &&
    !literal.startsWith(baseDir + sep) &&
    literal !== baseDirReal &&
    !literal.startsWith(baseDirReal + sep)
  ) {
    return { ok: false, error: "path outside baseDir" };
  }
  // realpath catches symlink escapes. ENOENT here means the file doesn't
  // exist yet (load) or the temp file was just renamed (save) — both are
  // the caller's concern, not a security failure.
  let real: string;
  try {
    real = await fs.realpath(literal);
  } catch (_e: unknown) {
    return { ok: false, error: "file not found" };
  }
  if (real !== baseDirReal && !real.startsWith(baseDirReal + sep)) {
    return { ok: false, error: "path outside baseDir" };
  }
  return { ok: true, path: real };
}
