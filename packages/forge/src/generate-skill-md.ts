/**
 * Pure function to generate SKILL.md with YAML frontmatter from structured input.
 *
 * Output format follows the Agent Skills specification:
 * ```
 * ---
 * name: skill-name
 * description: "What this skill does"
 * metadata:
 *   author: agent-id
 *   version: "0.0.1"
 *   tags:
 *     - tag1
 * ---
 *
 * <body content>
 * ```
 */

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface SkillMdInput {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly agentId: string;
  readonly version: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

/** Quote a string for YAML if it contains special characters. */
function yamlQuote(value: string): string {
  // Quote if it contains YAML special chars: colon, hash, brackets, quotes, etc.
  if (/[:#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    // Escape existing double-quotes and wrap in double-quotes
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateSkillMd(input: SkillMdInput): string {
  const lines: string[] = ["---"];

  lines.push(`name: ${yamlQuote(input.name)}`);
  lines.push(`description: ${yamlQuote(input.description)}`);

  // Metadata block
  lines.push("metadata:");
  lines.push(`  author: ${yamlQuote(input.agentId)}`);
  lines.push(`  version: ${yamlQuote(input.version)}`);

  // Tags (only include if non-empty)
  if (input.tags !== undefined && input.tags.length > 0) {
    lines.push("  tags:");
    for (const tag of input.tags) {
      lines.push(`    - ${yamlQuote(tag)}`);
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(input.body);

  return lines.join("\n");
}
