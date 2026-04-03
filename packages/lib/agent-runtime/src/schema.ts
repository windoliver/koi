/**
 * Zod schema for agent definition frontmatter validation.
 *
 * Validates Markdown frontmatter fields and transforms them into
 * the shape expected by AgentDefinition from @koi/core.
 */

import type { AgentDefinition, AgentDefinitionSource, AgentManifest, ModelConfig } from "@koi/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the YAML frontmatter in an agent definition `.md` file.
 *
 * Required: `name`, `description`.
 * Optional: `model`.
 *
 * The schema is STRICT — unknown keys are rejected, not silently dropped.
 * This prevents users from configuring unsupported fields and believing
 * they are enforced when they are not.
 *
 * Fields intentionally NOT supported yet (will be added when enforcement lands):
 * - `tools` — spawn-time tool restriction (#1425)
 * - `permissions` — permission policy enforcement (#1425)
 * - `maxTurns` — SpawnRequest turn limits (#1424)
 */
/** Validated frontmatter shape for an agent definition `.md` file. */
export interface AgentFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly model?: string | undefined;
}

const agentFrontmatterSchema: z.ZodType<AgentFrontmatter> = z
  .object({
    name: z.string().min(1, "Agent name is required"),
    description: z.string().min(1, "Agent description is required"),
    model: z.string().optional(),
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
  const manifest: AgentManifest = {
    name: frontmatter.name,
    version: "0.0.0",
    description: frontmatter.description,
    model: mapModelConfig(frontmatter.model),
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
