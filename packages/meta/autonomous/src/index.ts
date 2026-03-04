/**
 * @koi/autonomous — Coordinated autonomous agent composition (L3).
 *
 * Composes long-running harness + scheduler + optional compactor middleware
 * into a single AutonomousAgent with checkpoint/inbox support.
 * Optionally bridges harness completion to handoff envelopes.
 */
export { createAutonomousAgent } from "./autonomous.js";
export { createHarnessHandoffBridge } from "./bridge.js";
export type { BridgeAutoFireConfig, BridgeAutoFireHandle } from "./bridge-auto-fire.js";
export { createBridgeAutoFire } from "./bridge-auto-fire.js";
export { createCapabilityResolver } from "./capability-resolver.js";
export {
  generateCompletedPhaseDescription,
  generateWarnings,
  mapContextSummaryToDecisionRecord,
  mapKeyArtifactToArtifactRef,
  mapSnapshotToEnvelope,
  mapTaskResultsToJsonObject,
} from "./map-snapshot.js";
export type {
  AutonomousAgent,
  AutonomousAgentParts,
  HarnessHandoffBridge,
  HarnessHandoffBridgeConfig,
} from "./types.js";
