/**
 * BrickComponentMap — maps each BrickKind to its ECS component type.
 * Used by ForgeRuntime.resolve() for type-safe per-kind resolution.
 */

import type { ImplementationArtifact } from "./brick-store.js";
import type { AgentDescriptor, SkillComponent, Tool } from "./ecs.js";

export interface BrickComponentMap {
  readonly tool: Tool;
  readonly skill: SkillComponent;
  readonly agent: AgentDescriptor;
  readonly middleware: ImplementationArtifact;
  readonly channel: ImplementationArtifact;
}
