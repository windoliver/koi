/**
 * @koi/bash-ast/specs — public re-export barrel.
 *
 * See `docs/L2/bash-ast.md` "Per-command semantics" section and
 * `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`
 * for the full contract.
 */

export { specChmod } from "./chmod.js";
export { specChown } from "./chown.js";
export { specCp } from "./cp.js";
export { specCurl } from "./curl.js";
export { specMv } from "./mv.js";
export { BUILTIN_SPECS, createSpecRegistry, lookupSpec, registerSpec } from "./registry.js";
export { specRm } from "./rm.js";
export { specScp } from "./scp.js";
export { specSsh } from "./ssh.js";
export { specTar } from "./tar.js";
export type {
  CommandSemantics,
  CommandSpec,
  NetworkAccess,
  SpecResult,
} from "./types.js";
export { specWget } from "./wget.js";
