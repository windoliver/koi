import { posixBasename } from "./posix-basename.js";

/**
 * For each `src` in `srcs`, compute `prefix/<posixBasename(src)>`. If
 * any `src` cannot yield a basename (e.g., `/`, empty), the whole
 * call refuses with a parse-error detail naming the offending src.
 *
 * Used by `cp` and `mv` for `-t DIR` and destination-last forms.
 */

export type DeriveBasenamesResult =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly detail: string };

export function deriveBasenames(prefix: string, srcs: readonly string[]): DeriveBasenamesResult {
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  const paths: string[] = [];
  for (const src of srcs) {
    const base = posixBasename(src);
    if (!base.ok) {
      return { ok: false, detail: `unable to derive basename for src '${src}'` };
    }
    paths.push(`${normalizedPrefix}/${base.value}`);
  }
  return { ok: true, paths };
}
