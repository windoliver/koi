/**
 * CLI argument parser — entry point.
 *
 * Implementation has been split into per-command modules under ./args/.
 * This file is a redirect shim kept so that import paths (`./args.js`) remain
 * stable across the repo. All new code should import from `./args/index.js`
 * or directly from specific sub-modules (`./args/start.js`, etc.).
 */

export * from "./args/index.js";
