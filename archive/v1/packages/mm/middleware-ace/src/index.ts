/**
 * @koi/middleware-ace — Adaptive Continuous Enhancement (Layer 2)
 *
 * Records action/outcome trajectories per session, curates high-value patterns,
 * consolidates learnings into persistent playbooks, and auto-injects relevant
 * strategies into future sessions.
 *
 * Supports two pipelines:
 * - Stat-based (default): frequency x success rate x recency decay
 * - LLM-powered (3-agent ACE): reflector → curator → structured playbooks
 *
 * Depends on @koi/core only.
 */

// Main factory
export type { AceMiddlewareHandle } from "./ace.js";
export { createAceMiddleware } from "./ace.js";
// ACE tools provider (ComponentProvider for list_playbooks + ace_reflect + self-forge skill)
export type { AceToolsProviderConfig } from "./ace-tools-provider.js";
export { createAceToolsProvider } from "./ace-tools-provider.js";
// ATIF import/export
export type {
  AtifAgent,
  AtifDocument,
  AtifExportOptions,
  AtifFinalMetrics,
  AtifObservation,
  AtifObservationResult,
  AtifStep,
  AtifStepMetrics,
  AtifToolCall,
  AtifToolDefinition,
} from "./atif.js";
export { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./atif.js";
// ATIF write-behind buffer
export type { AtifWriteBehindBuffer, AtifWriteBehindBufferConfig } from "./atif-buffer.js";
export { createAtifWriteBehindBuffer } from "./atif-buffer.js";
// ATIF document store
export type { AtifDocumentDelegate, AtifDocumentStoreConfig } from "./atif-store.js";
export {
  createAtifDocumentStore,
  createInMemoryAtifDelegate,
  createInMemoryAtifDocumentStore,
} from "./atif-store.js";
// Audit adapter
export type { AuditTrajectoryAdapterConfig } from "./audit-adapter.js";
export {
  createAuditTrajectoryAdapter,
  mapAuditEntryToRichStep,
  mapPayloadToContent,
} from "./audit-adapter.js";
// Config
export type { AceConfig } from "./config.js";
export { validateAceConfig } from "./config.js";
// Consolidator (stat-based pipeline)
export type { DefaultConsolidatorOptions } from "./consolidator.js";
export { createDefaultConsolidator } from "./consolidator.js";
// Curator (LLM-powered pipeline)
export type { CuratorAdapter, CuratorModelCall } from "./curator.js";
export { applyOperations, createDefaultCurator } from "./curator.js";
// Descriptor + store accessor
export type { AceStores } from "./descriptor.js";
export { descriptor, getAceStores } from "./descriptor.js";
// Injector
export { selectPlaybooks } from "./injector.js";
// Pipeline
export type { ConsolidationPipeline } from "./pipeline.js";
export {
  compressRichTrajectory,
  createLlmPipeline,
  createStatPipeline,
  createTokenizerFn,
  isLlmPipelineEnabled,
} from "./pipeline.js";
// Playbook operations (structured playbooks)
export {
  computeBulletValue,
  createBulletId,
  createEmptyPlaybook,
  estimateStructuredTokens,
  extractCitedBulletIds,
  incrementCounter,
  normalizeBulletId,
  serializeForInjection,
} from "./playbook.js";
// Reflector
export type { ParseFailureCallback, ReflectorAdapter, ReflectorModelCall } from "./reflector.js";
export { createDefaultReflector, formatRichTrajectory } from "./reflector.js";
// Scoring
export { computeCurationScore, computeRecencyFactor } from "./scoring.js";
// Self-forge companion skill
export { SELF_FORGE_SKILL } from "./self-forge-skill.js";
// Stats aggregator (renamed from curator — stat-based curation)
export { type CurateOptions, curateTrajectorySummary } from "./stats-aggregator.js";
// Stores
export type { PlaybookStore, StructuredPlaybookStore, TrajectoryStore } from "./stores.js";
export {
  createInMemoryPlaybookStore,
  createInMemoryRichTrajectoryStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./stores.js";
// SQLite stores
export type {
  SqlitePlaybookStoreConfig,
  SqliteRichTrajectoryStoreConfig,
  SqliteStructuredPlaybookStoreConfig,
  SqliteTrajectoryStoreConfig,
} from "./stores-sqlite.js";
export {
  createSqlitePlaybookStore,
  createSqliteRichTrajectoryStore,
  createSqliteStructuredPlaybookStore,
  createSqliteTrajectoryStore,
} from "./stores-sqlite.js";
// ace_reflect tool
export type { AceReflectToolConfig } from "./tools/ace-reflect.js";
export { createAceReflectTool } from "./tools/ace-reflect.js";
// list_playbooks tool
export type { ListPlaybooksToolConfig } from "./tools/list-playbooks.js";
export { createListPlaybooksTool } from "./tools/list-playbooks.js";

// Buffer
export type { TrajectoryBuffer } from "./trajectory-buffer.js";
export { createTrajectoryBuffer } from "./trajectory-buffer.js";

// Types (re-exported from @koi/ace-types L0u for backward compatibility)
export type {
  AceFeedback,
  AggregatedStats,
  BulletTag,
  CurationCandidate,
  CuratorInput,
  CuratorOperation,
  Playbook,
  PlaybookBullet,
  PlaybookSection,
  PlaybookSource,
  ReflectionResult,
  ReflectorInput,
  StructuredPlaybook,
  TrajectoryEntry,
} from "./types.js";
