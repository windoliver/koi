/**
 * NL injection semantic scan rule — placeholder for server-side LLM execution.
 *
 * Locally this rule is a no-op (returns no findings). The community registry
 * server fills in the actual scan via an LLM call at publish time.
 * The ScanRule interface is the extension point; the actual LLM call is
 * server configuration.
 */

import type { ScanRule } from "../types.js";

export const nlInjectionRule: ScanRule = {
  name: "nl-injection-semantic",
  category: "PROMPT_INJECTION",
  defaultSeverity: "CRITICAL",
  check: () => [],
};
