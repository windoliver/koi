/**
 * Forge type aliases — extension points for the self-extension system.
 *
 * TrustTier lives in ecs.ts (used by Tool interface).
 * These are additional L0 types used by @koi/forge (L2).
 */

/** Visibility scope of a forged brick. */
export type ForgeScope = "agent" | "zone" | "global";

/** Lifecycle state of a forged brick artifact. */
export type BrickLifecycle =
  | "draft"
  | "verifying"
  | "active"
  | "failed"
  | "deprecated"
  | "quarantined";

/** Kind of forged brick (tool, skill, agent, composite, middleware, channel). */
export type BrickKind = "tool" | "skill" | "agent" | "composite" | "middleware" | "channel";
