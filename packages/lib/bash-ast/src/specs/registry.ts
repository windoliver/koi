import { specChmod } from "./chmod.js";
import { specChown } from "./chown.js";
import { specCp } from "./cp.js";
import { specCurl } from "./curl.js";
import { specMv } from "./mv.js";
import { posixBasename } from "./posix-basename.js";
import { specRm } from "./rm.js";
import { specScp } from "./scp.js";
import { specSsh } from "./ssh.js";
import { specTar } from "./tar.js";
import type { CommandSpec } from "./types.js";
import { specWget } from "./wget.js";

const BUILTIN_ENTRIES: ReadonlyArray<readonly [string, CommandSpec]> = [
  ["rm", specRm],
  ["cp", specCp],
  ["mv", specMv],
  ["chmod", specChmod],
  ["chown", specChown],
  ["curl", specCurl],
  ["wget", specWget],
  ["tar", specTar],
  ["scp", specScp],
  ["ssh", specSsh],
];

const _builtinBacking = new Map<string, CommandSpec>(BUILTIN_ENTRIES);

const MUTATOR_NAMES: ReadonlySet<string> = new Set(["set", "delete", "clear"]);

/**
 * Read-only map of the ten builtin specs keyed by command name. Useful
 * for callers that only need lookup. Use `createSpecRegistry()` when
 * you need a mutable registry to register custom specs alongside.
 *
 * The exported value is a `Proxy` that throws on mutator methods so the
 * `ReadonlyMap` typing is enforced at runtime — JS callers (or TS callers
 * that cast away the type) cannot poison the builtin table for the whole
 * process by calling `.set()` / `.delete()` / `.clear()`.
 */
export const BUILTIN_SPECS: ReadonlyMap<string, CommandSpec> = new Proxy(_builtinBacking, {
  get(target, prop, _receiver) {
    if (typeof prop === "string" && MUTATOR_NAMES.has(prop)) {
      return () => {
        throw new TypeError(
          "BUILTIN_SPECS is immutable; use createSpecRegistry() to get a mutable copy",
        );
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

/**
 * Returns a fresh mutable `Map` seeded with all ten builtins. Each
 * caller gets an independent registry — there is no module-level
 * shared mutable state.
 */
export function createSpecRegistry(): Map<string, CommandSpec> {
  return new Map(BUILTIN_SPECS);
}

/**
 * Adds `fn` to `reg` under `name`. Thin wrapper over `Map.set` to
 * satisfy the issue's "registerSpec exposed from @koi/bash-ast" API
 * surface; consumers may equivalently call `reg.set(name, fn)`.
 */
export function registerSpec(reg: Map<string, CommandSpec>, name: string, fn: CommandSpec): void {
  reg.set(name, fn);
}

/**
 * Look up a spec for `argv[0]`. Accepts bare command names (`rm`) and
 * absolute system paths (`/bin/rm`); refuses relative paths (`./rm`,
 * `../bin/rm`) which are likely user wrappers and should not inherit
 * trusted builtin semantics. See `matchesCommand` for the full policy.
 *
 * NOTE: even for absolute paths, this only checks the basename. A
 * consumer using these specs for authorization MUST additionally verify
 * the executable identity (canonicalize symlinks, allowlist paths).
 */
export function lookupSpec(
  reg: ReadonlyMap<string, CommandSpec>,
  argv0: string | undefined,
): CommandSpec | undefined {
  if (argv0 === undefined || argv0 === "") return undefined;
  if (!argv0.includes("/")) return reg.get(argv0);
  if (!argv0.startsWith("/")) return undefined;
  const base = posixBasename(argv0);
  if (!base.ok) return undefined;
  return reg.get(base.value);
}
