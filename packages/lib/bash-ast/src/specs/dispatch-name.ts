import { posixBasename } from "./posix-basename.js";

/**
 * Returns `true` when `argv[0]`'s POSIX basename equals `expected`.
 * Walker output preserves the literal command token, so `/bin/rm` and
 * `rm` should both pass `matchesCommand("rm", argv)`. Empty argv or
 * undefined argv[0] returns `false`.
 */
export function matchesCommand(expected: string, argv: readonly string[]): boolean {
  const head = argv[0];
  if (head === undefined) return false;
  const base = posixBasename(head);
  return base.ok && base.value === expected;
}
