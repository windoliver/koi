/**
 * Rules-loader preset stack — hierarchical project rule injection.
 *
 * Walks from `cwd` to the git root, merges CLAUDE.md / AGENTS.md /
 * .koi/context.md into the system prompt on every model call. One
 * middleware, no shared state. Both hosts benefit: the CLI REPL
 * gets project context too, not just the TUI.
 */

import { createRulesMiddleware } from "@koi/rules-loader";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

export const rulesStack: PresetStack = {
  id: "rules",
  description: "Hierarchical project rule injection (CLAUDE.md, AGENTS.md, .koi/context.md)",
  activate: (ctx): StackContribution => ({
    middleware: [createRulesMiddleware({ cwd: ctx.cwd })],
    providers: [],
  }),
};
