/**
 * Plan-persist adapter configuration and validation.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Subset of `node:fs/promises` the adapter actually uses. Pluggable for tests. */
export interface PlanPersistFs {
  readonly mkdir: (path: string, options: { readonly recursive: true }) => Promise<unknown>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly stat: (path: string) => Promise<unknown>;
  readonly realpath: (path: string) => Promise<string>;
  readonly unlink: (path: string) => Promise<void>;
  /**
   * Hardlink an existing file to a new path. Required for exclusive-create
   * commits: `link` is atomic and fails with `EEXIST` when the destination
   * already exists, while `rename` would silently overwrite. Plain POSIX
   * link semantics — no special flags. Implementations that cannot support
   * hardlinks (e.g. some object-store-backed shims) MAY fall back to
   * `copyFile(src, dst, COPYFILE_EXCL)` which has equivalent semantics.
   */
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
}

export interface PlanPersistConfig {
  /** Plans directory. Defaults to `.koi/plans`. Resolved against `cwd`. Must stay under `cwd`. */
  readonly baseDir?: string | undefined;
  /** Project root used to anchor relative paths and the path-traversal check. Defaults to `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** Pluggable filesystem. Defaults to `node:fs/promises`. */
  readonly fs?: PlanPersistFs | undefined;
  /** Clock for timestamp prefixes. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** PRNG for slug generation, returns [0, 1). Defaults to `Math.random`. */
  readonly rand?: (() => number) | undefined;
}

export const DEFAULT_BASE_DIR = ".koi/plans";

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validatePlanPersistConfig(config: unknown): Result<PlanPersistConfig, KoiError> {
  if (config === null || config === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }
  const c = config as Record<string, unknown>;

  if (c.baseDir !== undefined && typeof c.baseDir !== "string") {
    return validationError("baseDir must be a string");
  }
  if (c.cwd !== undefined && typeof c.cwd !== "string") {
    return validationError("cwd must be a string");
  }
  if (c.fs !== undefined) {
    if (typeof c.fs !== "object" || c.fs === null) {
      return validationError("fs must be an object");
    }
    // Fail fast on missing methods. Otherwise an out-of-tree shim that
    // forgot to implement (say) `link` only crashes on the first
    // savePlan call deep into the agent run, far from the construction
    // site that's actually responsible.
    const required: readonly (keyof PlanPersistFs)[] = [
      "mkdir",
      "writeFile",
      "readFile",
      "rename",
      "stat",
      "realpath",
      "unlink",
      "link",
    ];
    for (const method of required) {
      const fn = (c.fs as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        return validationError(`fs.${method} must be a function`);
      }
    }
  }
  if (c.now !== undefined && typeof c.now !== "function") {
    return validationError("now must be a function");
  }
  if (c.rand !== undefined && typeof c.rand !== "function") {
    return validationError("rand must be a function");
  }

  return { ok: true, value: config as PlanPersistConfig };
}
