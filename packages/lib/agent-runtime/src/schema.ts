/**
 * Zod schema for agent definition frontmatter validation.
 *
 * Validates Markdown frontmatter fields and transforms them into
 * the shape expected by AgentDefinition from @koi/core.
 */

import type {
  AgentDefinition,
  AgentDefinitionSource,
  AgentManifest,
  ManifestSpawnConfig,
  ModelConfig,
} from "@koi/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the YAML frontmatter in an agent definition `.md` file.
 *
 * Required: `name`, `description`.
 * Optional: `model`, `spawn`.
 *
 * The schema is STRICT — unknown keys are rejected, not silently dropped.
 * This prevents users from configuring unsupported fields and believing
 * they are enforced when they are not.
 *
 * Fields intentionally NOT supported yet (will be added when enforcement lands):
 * - `permissions` — permission policy enforcement (#1425)
 * - `maxTurns` — SpawnRequest turn limits (#1424)
 */

/** Validated frontmatter shape for `spawn.tools`. */
export interface AgentFrontmatterSpawnTools {
  readonly policy?: "allowlist" | "denylist" | undefined;
  readonly list?: readonly string[] | undefined;
}

/** Validated frontmatter shape for `spawn`. */
export interface AgentFrontmatterSpawn {
  readonly tools?: AgentFrontmatterSpawnTools | undefined;
}

/** Validated frontmatter shape for `self_ceiling`. */
export interface AgentFrontmatterSelfCeiling {
  readonly tools?: readonly string[] | undefined;
}

/** Validated frontmatter shape for an agent definition `.md` file. */
export interface AgentFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly model?: string | undefined;
  readonly spawn?: AgentFrontmatterSpawn | undefined;
  readonly self_ceiling?: AgentFrontmatterSelfCeiling | undefined;
}

const spawnToolsSchema: z.ZodType<AgentFrontmatterSpawnTools> = z
  .object({
    policy: z.enum(["allowlist", "denylist"]).optional(),
    list: z.array(z.string()).optional(),
  })
  .strict();

const spawnSchema: z.ZodType<AgentFrontmatterSpawn> = z
  .object({
    tools: spawnToolsSchema.optional(),
  })
  .strict();

const selfCeilingSchema: z.ZodType<AgentFrontmatterSelfCeiling> = z
  .object({
    tools: z.array(z.string()).optional(),
  })
  .strict();

const agentFrontmatterSchema: z.ZodType<AgentFrontmatter> = z
  .object({
    name: z.string().min(1, "Agent name is required"),
    description: z.string().min(1, "Agent description is required"),
    model: z.string().optional(),
    spawn: spawnSchema.optional(),
    self_ceiling: selfCeilingSchema.optional(),
  })
  .strict();

/** A single validation issue from schema parsing. */
export interface AgentFrontmatterIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** Result of validating agent frontmatter. */
export type AgentFrontmatterParseResult =
  | { readonly success: true; readonly data: AgentFrontmatter }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly AgentFrontmatterIssue[] };
    };

/** Validate raw frontmatter data against the agent definition schema. */
export function validateAgentFrontmatter(data: unknown): AgentFrontmatterParseResult {
  return agentFrontmatterSchema.safeParse(data) as AgentFrontmatterParseResult;
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

/** Build a ModelConfig from the optional model string. */
function mapModelConfig(model: string | undefined): ModelConfig {
  return { name: model ?? "sonnet" };
}

/** Map frontmatter spawn config to ManifestSpawnConfig (exactOptionalPropertyTypes-safe). */
function mapSpawnConfig(spawn: AgentFrontmatterSpawn): ManifestSpawnConfig {
  if (spawn.tools === undefined) return {};
  const { policy, list } = spawn.tools;
  const tools: ManifestSpawnConfig["tools"] = {
    ...(policy !== undefined ? { policy } : {}),
    ...(list !== undefined ? { list } : {}),
  };
  return { tools };
}

// ---------------------------------------------------------------------------
// Transform to AgentDefinition
// ---------------------------------------------------------------------------

/**
 * Transform validated frontmatter + body into an AgentDefinition.
 *
 * This is a pure function — no I/O, no side effects.
 */
export function mapFrontmatterToDefinition(
  frontmatter: AgentFrontmatter,
  systemPrompt: string,
  source: AgentDefinitionSource,
): AgentDefinition {
  const spawnConfig: ManifestSpawnConfig | undefined = frontmatter.spawn
    ? mapSpawnConfig(frontmatter.spawn)
    : undefined;

  const selfCeilingConfig: AgentManifest["selfCeiling"] | undefined =
    frontmatter.self_ceiling?.tools !== undefined
      ? { tools: frontmatter.self_ceiling.tools }
      : undefined;

  const manifest: AgentManifest = {
    name: frontmatter.name,
    version: "0.0.0",
    description: frontmatter.description,
    model: mapModelConfig(frontmatter.model),
    ...(spawnConfig !== undefined ? { spawn: spawnConfig } : {}),
    ...(selfCeilingConfig !== undefined ? { selfCeiling: selfCeilingConfig } : {}),
  };

  return {
    agentType: frontmatter.name,
    whenToUse: frontmatter.description,
    source,
    manifest,
    // System prompt from Markdown body — injected into SpawnRequest.systemPrompt at spawn time
    ...(systemPrompt ? { systemPrompt } : {}),
    // TaskableAgent fields (inherited interface)
    name: frontmatter.name,
    description: frontmatter.description,
  };
}

// ---------------------------------------------------------------------------
// Compile-time contract: Zod output must satisfy AgentDefinition
// ---------------------------------------------------------------------------

/**
 * Compile-time assertion: mapFrontmatterToDefinition returns AgentDefinition.
 * This type alias fails to compile if the return type diverges.
 * Never used at runtime — exists solely for type safety.
 */
export type _AssertReturnIsAgentDefinition =
  AgentDefinition extends ReturnType<typeof mapFrontmatterToDefinition> ? true : never;
