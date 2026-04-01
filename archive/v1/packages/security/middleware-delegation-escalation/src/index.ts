/**
 * @koi/middleware-delegation-escalation — Human escalation on delegation exhaustion (Layer 2)
 *
 * When all delegatee circuit breakers are open, pauses the engine loop
 * and asks a human for instructions via the bidirectional channel contract.
 */

// escalation gate
export type { EscalationGate } from "./escalation-gate.js";
export { createEscalationGate, parseHumanResponse } from "./escalation-gate.js";

// escalation message
export { generateEscalationMessage } from "./escalation-message.js";
// middleware factory
export { createDelegationEscalationMiddleware } from "./middleware.js";
// types
export type {
  DelegationEscalationConfig,
  DelegationEscalationHandle,
  EscalationContext,
  EscalationDecision,
} from "./types.js";
export { DEFAULT_ESCALATION_TIMEOUT_MS } from "./types.js";
