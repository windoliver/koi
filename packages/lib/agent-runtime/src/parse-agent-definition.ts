/**
 * Agent definition parser — Markdown content → AgentDefinition.
 *
 * Pipeline: content → parseFrontmatter() → validateAgentFrontmatter()
 *           → validateAgentType() → mapFrontmatterToDefinition()
 */

import type { AgentDefinition, AgentDefinitionSource, KoiError, Result } from "@koi/core";
import { parseFrontmatter } from "./frontmatter.js";
import { mapFrontmatterToDefinition, validateAgentFrontmatter } from "./schema.js";
import { validateAgentType } from "./validate-agent-type.js";

/**
 * Parse a Markdown string into an AgentDefinition.
 *
 * The content should be a Markdown file with YAML frontmatter:
 * ```markdown
 * ---
 * name: researcher
 * description: Deep research agent
 * model: sonnet
 * tools: [Read, Grep, WebSearch]
 * ---
 *
 * You are a research specialist...
 * ```
 *
 * Returns a typed error on any validation failure.
 */
export function parseAgentDefinition(
  content: string,
  source: AgentDefinitionSource,
): Result<AgentDefinition, KoiError> {
  // Step 1: Parse frontmatter
  const fmResult = parseFrontmatter(content);
  if (!fmResult.ok) return fmResult;

  const { meta, body } = fmResult.value;

  // Step 2: Validate frontmatter schema
  const schemaResult = validateAgentFrontmatter(meta);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid agent definition: ${issues.join("; ")}`,
        retryable: false,
      },
    };
  }

  // Step 3: Validate agent type name
  const typeResult = validateAgentType(schemaResult.data.name);
  if (!typeResult.ok) return typeResult;

  // Step 4: Transform to AgentDefinition
  return {
    ok: true,
    value: mapFrontmatterToDefinition(schemaResult.data, body, source),
  };
}
