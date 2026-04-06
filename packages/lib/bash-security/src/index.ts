/**
 * @koi/bash-security — Bash command security classifiers.
 *
 * Three independent classifiers (injection, path, command) plus an
 * orchestration pipeline. Zero npm dependencies — Node.js built-ins only.
 */

// Individual classifiers
export { classifyCommand } from "./bash-classifier.js";
// Orchestration pipeline
export { classifyBashCommand } from "./classify.js";
export { detectInjection } from "./injection-detector.js";
export { validatePath } from "./path-validator.js";
// Types
export type { BashPolicy, ClassificationResult, ThreatCategory, ThreatPattern } from "./types.js";
export { DEFAULT_BASH_POLICY } from "./types.js";
