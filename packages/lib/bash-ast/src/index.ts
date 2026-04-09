/**
 * @koi/bash-ast — AST-based bash command analysis for permission matching.
 *
 * Public API:
 *   - `initializeBashAst()`   — one-time async parser init (cached promise)
 *   - `analyzeBashCommand()`  — pure AST analysis, returns AstAnalysis
 *   - `classifyBashCommand()` — transitional tool-facing classifier with
 *                               prefilter + AST + regex fallback (returns
 *                               ClassificationResult compatible with
 *                               @koi/bash-security)
 *   - `matchSimpleCommand()`  — pure matcher for BashRulePattern
 *
 * See `docs/L2/bash-ast.md` for the full design rationale.
 */

export { analyzeBashCommand, MAX_COMMAND_LENGTH } from "./analyze.js";
export { type ClassifyOptions, classifyBashCommand } from "./classify.js";
export { initializeBashAst } from "./init.js";
export { matchSimpleCommand } from "./matcher.js";
export type { AstAnalysis, Redirect, SimpleCommand } from "./types.js";
