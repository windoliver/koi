// packages/sandbox/sandbox-router/src/index.ts

export type {
  BuildDecisionInput,
  SelectionAttempt,
  SelectionDecision,
} from "./decision.js";
export { buildDecision } from "./decision.js";
export type { MatchRejection, MatchResult } from "./match.js";
export { matchAdapters } from "./match.js";
export type { RouterConfig, SandboxRouter } from "./router.js";
export { createSandboxRouter } from "./router.js";
