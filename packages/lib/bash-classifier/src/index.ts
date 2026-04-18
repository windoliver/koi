/**
 * @koi/bash-classifier — ARITY-based prefix extraction + structural
 * dangerous-pattern registry for bash permission policy.
 *
 * See `docs/L2/bash-classifier.md` for the full design.
 */

export { ARITY } from "./arity.js";
export { classifyCommand } from "./classify.js";
export { DANGEROUS_PATTERNS } from "./patterns.js";
export { prefix } from "./prefix.js";
export type { Category, ClassifyResult, DangerousPattern, Severity } from "./types.js";
