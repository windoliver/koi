/**
 * @koi/forge-types — shared type + contract surfaces for the forge subsystem.
 *
 * L0u: depends only on `@koi/core`. Imported by every L2 forge package.
 * Types-only with pure type-guard helpers — zero runtime side effects.
 */

export type {
  CompletedForgeArtifact,
  FailableForgeStage,
  ForgeArtifact,
  ForgeCandidate,
  ForgeDemand,
  ForgeDemandStatus,
  ForgeEvent,
  ForgeLifecycleState,
  ForgeMiddlewareConfig,
  ForgePolicy,
  ForgePolicyVerdict,
  ForgeToolInput,
  ForgeToolResult,
  PublishedForgeLifecycleState,
} from "./types.js";

export {
  isFailableForgeStage,
  isForgeEvent,
  isForgeLifecycleState,
  isPublishedForgeLifecycleState,
  isTerminalForgeLifecycle,
} from "./types.js";
