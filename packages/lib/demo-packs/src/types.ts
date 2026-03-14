/**
 * Demo pack types — define the shape of seeders and their results.
 */

import type { NexusClient } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Agent roles
// ---------------------------------------------------------------------------

/** Lifecycle type for agent roles within a demo pack. */
export type AgentLifecycle = "copilot" | "worker";

/** An agent role provisioned by a demo pack. */
export interface AgentRole {
  readonly name: string;
  readonly type: AgentLifecycle;
  readonly lifecycle: AgentLifecycle;
  readonly reuse: boolean;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Seed context and result
// ---------------------------------------------------------------------------

/** Context passed to a demo pack's seed function. */
export interface SeedContext {
  /** Nexus client for provisioning data. */
  readonly nexusClient: NexusClient;
  /** Agent name from the manifest. */
  readonly agentName: string;
  /** Workspace root directory. */
  readonly workspaceRoot: string;
  /** Whether to print verbose output. */
  readonly verbose: boolean;
}

/** A seeded brick snapshot for forge view hydration. */
export interface SeededBrickView {
  readonly brickId: string;
  readonly name: string;
  readonly status: "active" | "deprecated" | "promoted" | "quarantined";
  readonly fitness: number;
  readonly sampleCount: number;
  readonly createdAt: number;
  readonly lastUpdatedAt: number;
}

/** Result of running a demo pack's seed function. */
export interface SeedResult {
  readonly ok: boolean;
  /** Number of entities seeded by category. */
  readonly counts: Readonly<Record<string, number>>;
  /** Human-readable summary lines. */
  readonly summary: readonly string[];
  /** Optional pre-computed brick views for forge view hydration. */
  readonly seededBricks?: readonly SeededBrickView[];
}

// ---------------------------------------------------------------------------
// Demo pack definition
// ---------------------------------------------------------------------------

/** A complete demo pack with metadata, seed function, and known-good prompts. */
export interface DemoPack {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Required add-on IDs for this pack to work. */
  readonly requires: readonly string[];
  /** Agent roles this pack provisions. */
  readonly agentRoles: readonly AgentRole[];
  /** The seed function that provisions demo data. */
  readonly seed: (ctx: SeedContext) => Promise<SeedResult>;
  /** Known-good prompts to suggest after seeding. */
  readonly prompts: readonly string[];
}
