/**
 * Built-in rule registry for @koi/doctor.
 *
 * All 25 rules across 10 OWASP Agentic categories.
 */

import type { DoctorRule } from "../types.js";
import { cascadingFailuresRules } from "./cascading-failures.js";
import { codeExecutionRules } from "./code-execution.js";
import { goalHijackRules } from "./goal-hijack.js";
import { humanTrustRules } from "./human-trust.js";
import { insecureDelegationRules } from "./insecure-delegation.js";
import { memoryPoisoningRules } from "./memory-poisoning.js";
import { privilegeAbuseRules } from "./privilege-abuse.js";
import { rogueAgentsRules } from "./rogue-agents.js";
import { supplyChainRules } from "./supply-chain.js";
import { toolMisuseRules } from "./tool-misuse.js";

const BUILTIN_RULES: readonly DoctorRule[] = [
  ...goalHijackRules,
  ...toolMisuseRules,
  ...codeExecutionRules,
  ...privilegeAbuseRules,
  ...insecureDelegationRules,
  ...supplyChainRules,
  ...memoryPoisoningRules,
  ...cascadingFailuresRules,
  ...humanTrustRules,
  ...rogueAgentsRules,
];

export function getBuiltinRules(): readonly DoctorRule[] {
  return BUILTIN_RULES;
}
