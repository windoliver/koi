/**
 * @koi/errors — Shared runtime error class for L2 packages.
 *
 * Wraps the KoiError data type from @koi/core with a proper Error subclass,
 * giving middleware and feature packages stack traces + instanceof checks
 * while keeping L0 pure (types only).
 */

export { KoiRuntimeError } from "./runtime-error.js";
