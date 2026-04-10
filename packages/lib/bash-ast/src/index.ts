/**
 * @koi/bash-ast — AST-based bash command analysis for permission matching.
 *
 * Public API:
 *   - `initializeBashAst()`   — one-time async parser init (cached promise)
 *   - `analyzeBashCommand()`  — pure AST analysis, returns AstAnalysis
 *   - `classifyBashCommand()` — sync tool-facing classifier with prefilter +
 *                               AST + regex TTP fallback for too-complex.
 *                               Returns `ClassificationResult` compatible
 *                               with `@koi/bash-security`. Use for tests
 *                               and non-interactive callers.
 *   - `classifyBashCommandWithElicit()` — async classifier that replaces
 *                               the regex fallback with an interactive
 *                               `elicit` callback. Use from runtime
 *                               contexts with a TUI/CLI prompt surface.
 *                               Closes #1634's full fail-closed loop.
 *   - `matchSimpleCommand()`  — pure matcher for BashRulePattern
 *
 * See `docs/L2/bash-ast.md` for the full design rationale.
 */

export { analyzeBashCommand, MAX_COMMAND_LENGTH } from "./analyze.js";
export {
  type ClassifyOptions,
  type ClassifyOptionsWithElicit,
  classifyBashCommand,
  classifyBashCommandWithElicit,
  type ElicitCallback,
} from "./classify.js";
export { initializeBashAst } from "./init.js";
export { matchSimpleCommand } from "./matcher.js";
export type { AstAnalysis, Redirect, SimpleCommand } from "./types.js";
