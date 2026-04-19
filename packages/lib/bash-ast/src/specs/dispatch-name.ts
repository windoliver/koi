/**
 * Returns `true` when `argv[0]` is exactly the bare `expected` command name.
 *
 * Path-qualified executables (`/bin/rm`, `/tmp/rm`, `./rm`, `../bin/rm`) are
 * REFUSED — the spec layer cannot tell `/usr/bin/curl` from `/tmp/curl` (a
 * wrapper) just from a basename match, and reporting builtin semantics for
 * an arbitrary executable can hide side effects that the wrapper performs.
 *
 * Consumers that want to dispatch a path-qualified invocation to a builtin
 * spec MUST first verify the executable identity (canonicalize symlinks,
 * resolve against a vetted PATH/allowlist) and then pass the bare command
 * name to the spec. The spec layer intentionally does not perform that
 * trust check.
 */
export function matchesCommand(expected: string, argv: readonly string[]): boolean {
  return argv[0] === expected;
}
