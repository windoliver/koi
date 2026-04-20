/**
 * Pure POSIX-style basename. Strips trailing `/` from the input, then
 * returns the segment after the last `/`. Refuses `/`, empty input,
 * and any input whose stripped form is empty.
 *
 * Returns a Result so callers can fold into `kind: "refused"` without
 * exception handling.
 */

export type BasenameResult = { readonly ok: true; readonly value: string } | { readonly ok: false };

export function posixBasename(src: string): BasenameResult {
  if (src === "") return { ok: false };

  let end = src.length;
  // Strip trailing slashes
  while (end > 0 && src[end - 1] === "/") end -= 1;
  if (end === 0) return { ok: false };

  const stripped = src.slice(0, end);
  const lastSlash = stripped.lastIndexOf("/");
  const value = lastSlash === -1 ? stripped : stripped.slice(lastSlash + 1);
  if (value === "") return { ok: false };
  return { ok: true, value };
}
