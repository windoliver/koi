import { posixBasename } from "./posix-basename.js";

/**
 * Returns `true` when `argv[0]` should dispatch to the spec for `expected`.
 *
 * Accepts:
 *   - bare command names: `rm`, `cp`, `curl`
 *   - absolute system paths: `/bin/rm`, `/usr/bin/curl`, `/usr/local/bin/tar`
 *
 * Refuses:
 *   - relative paths: `./rm`, `../bin/rm`, `bin/curl` (likely user wrappers
 *     that shouldn't inherit trusted builtin semantics; consumer should
 *     handle these via exact-argv `Run(...)` rules)
 *   - empty/undefined argv[0]
 *   - any argv[0] whose basename is the empty string or `/`
 *
 * NOTE: even for absolute paths, this helper only checks the basename. A
 * consumer that uses these specs for authorization MUST additionally verify
 * the executable identity (canonicalize symlinks, allowlist paths, etc.).
 * `/usr/local/bin/curl` may be a wrapper masquerading as the system curl.
 * The spec layer cannot distinguish; that is a consumer-side concern.
 */
export function matchesCommand(expected: string, argv: readonly string[]): boolean {
  const head = argv[0];
  if (head === undefined || head === "") return false;
  if (!head.includes("/")) return head === expected;
  if (!head.startsWith("/")) return false;
  const base = posixBasename(head);
  return base.ok && base.value === expected;
}
