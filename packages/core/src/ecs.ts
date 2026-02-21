/**
 * ECS compositional layer — Agent (entity), SubsystemToken (component key),
 * Tool, ComponentProvider, and singleton component types.
 *
 * Exception: branded type constructors (identity casts for SubsystemToken<T>)
 * are permitted in L0 as they are zero-logic operations that exist purely for
 * type safety.
 */

import type { AgentManifest } from "./assembly.js";
import type { ChannelAdapter } from "./channel.js";

// ---------------------------------------------------------------------------
// Branded token
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;

export type SubsystemToken<T> = string & {
  readonly [__brand]: T;
};

// ---------------------------------------------------------------------------
// Token factories (branded casts — sole runtime code in L0)
// ---------------------------------------------------------------------------

export function token<T>(name: string): SubsystemToken<T> {
  return name as SubsystemToken<T>;
}

export function toolToken(name: string): SubsystemToken<ToolDescriptor> {
  return `tool:${name}` as SubsystemToken<ToolDescriptor>;
}

export function channelToken(name: string): SubsystemToken<ChannelAdapter> {
  return `channel:${name}` as SubsystemToken<ChannelAdapter>;
}

export function skillToken(name: string): SubsystemToken<SkillMetadata> {
  return `skill:${name}` as SubsystemToken<SkillMetadata>;
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

export type ProcessState = "created" | "running" | "waiting" | "suspended" | "terminated";

export interface ProcessId {
  readonly id: string;
  readonly name: string;
  readonly type: "copilot" | "worker";
  readonly depth: number;
  readonly parent?: string;
}

// ---------------------------------------------------------------------------
// Agent (ECS entity)
// ---------------------------------------------------------------------------

export interface Agent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;
  readonly state: ProcessState;
  readonly component: <T>(token: SubsystemToken<T>) => T | undefined;
  readonly has: (token: SubsystemToken<unknown>) => boolean;
  readonly query: (...tokens: readonly SubsystemToken<unknown>[]) => boolean;
  readonly components: () => ReadonlyMap<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool & Skill
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly execute: (input: unknown) => Promise<unknown>;
}

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

// ---------------------------------------------------------------------------
// Component provider
// ---------------------------------------------------------------------------

export interface ComponentProvider {
  readonly name: string;
  readonly attach: (agent: Agent) => ReadonlyMap<string, unknown>;
}

// ---------------------------------------------------------------------------
// Singleton component types (sub-types deferred to L2)
// ---------------------------------------------------------------------------

export interface MemoryComponent {
  readonly recall: (query: string) => Promise<readonly unknown[]>;
  readonly store: (content: unknown) => Promise<void>;
}

export interface GovernanceComponent {
  readonly check: (action: string) => Promise<boolean>;
}

export interface CredentialComponent {
  readonly get: (key: string) => Promise<string | undefined>;
}

export interface EventComponent {
  readonly emit: (type: string, data: unknown) => void;
  readonly on: (type: string, handler: (data: unknown) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Well-known singleton tokens
// ---------------------------------------------------------------------------

export const MEMORY: SubsystemToken<MemoryComponent> = token<MemoryComponent>("memory");
export const GOVERNANCE: SubsystemToken<GovernanceComponent> =
  token<GovernanceComponent>("governance");
export const CREDENTIALS: SubsystemToken<CredentialComponent> =
  token<CredentialComponent>("credentials");
export const EVENTS: SubsystemToken<EventComponent> = token<EventComponent>("events");
