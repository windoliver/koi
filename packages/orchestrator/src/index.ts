/**
 * @koi/orchestrator — persistent task board coordinator for multi-agent swarms.
 *
 * Provides a DAG-based task board with dependency tracking, concurrent worker
 * assignment, failure/retry handling, and checkpointing.
 */

export { executeAssignWorker } from "./assign-worker-tool.js";

// board
export { createTaskBoard } from "./board.js";
// checkpoint
export { deserializeBoard, serializeBoard } from "./checkpoint.js";
// config
export { validateOrchestratorConfig } from "./config.js";
// dag
export { detectCycle, topologicalSort } from "./dag.js";
export type { BoardHolder } from "./orchestrate-tool.js";
// tool executors
export { executeOrchestrate } from "./orchestrate-tool.js";
// provider
export { createOrchestratorProvider } from "./provider.js";
export { executeReviewOutput } from "./review-output-tool.js";
// skill
export {
  ORCHESTRATOR_SKILL,
  ORCHESTRATOR_SKILL_CONTENT,
  ORCHESTRATOR_SKILL_NAME,
} from "./skill.js";
export { mapSpawnToWorker } from "./spawn-adapter.js";
export { executeSynthesize } from "./synthesize-tool.js";
// types
export type {
  OrchestratorConfig,
  SpawnWorkerFn,
  SpawnWorkerRequest,
  SpawnWorkerResult,
  VerifyResult,
  VerifyResultFn,
} from "./types.js";
// tools
export {
  ASSIGN_WORKER_TOOL_DESCRIPTOR,
  ORCHESTRATE_TOOL_DESCRIPTOR,
  REVIEW_OUTPUT_TOOL_DESCRIPTOR,
  SYNTHESIZE_TOOL_DESCRIPTOR,
} from "./types.js";
