import { specChmod } from "./chmod.js";
import { specChown } from "./chown.js";
import { specCp } from "./cp.js";
import { specCurl } from "./curl.js";
import { specMv } from "./mv.js";
import { specRm } from "./rm.js";
import { specScp } from "./scp.js";
import { specSsh } from "./ssh.js";
import { specTar } from "./tar.js";
import type { CommandSpec } from "./types.js";
import { specWget } from "./wget.js";

/**
 * Read-only map of the ten builtin specs keyed by command name. Useful
 * for callers that only need lookup. Use `createSpecRegistry()` when
 * you need a mutable registry to register custom specs alongside.
 */
export const BUILTIN_SPECS: ReadonlyMap<string, CommandSpec> = new Map<string, CommandSpec>([
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
]);

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
