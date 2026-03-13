/**
 * Wraps existing MCP tools with policy/provenance.
 * Does NOT forge duplicate connectors.
 */

import type { DataSourceDescriptor } from "@koi/core";
import type { ForgeSkillInput } from "@koi/forge-types";
import type { SkillStrategy } from "../types.js";

export function createMcpStrategy(): SkillStrategy {
  return {
    protocol: "mcp",
    generateInput(descriptor: DataSourceDescriptor): ForgeSkillInput {
      const body = [
        `# ${descriptor.name} — MCP Data Source`,
        "",
        descriptor.description ?? "Data access via MCP tool.",
        "",
        "## Usage",
        "",
        'Use `query_datasource` with `protocol: "mcp"` to invoke the underlying MCP tool.',
        "The tool name and arguments are passed through to the MCP server.",
      ].join("\n");

      return {
        kind: "skill",
        name: `datasource-${descriptor.name}`,
        description: `Data access patterns for ${descriptor.name} (MCP)`,
        tags: ["datasource", "mcp", descriptor.name],
        body,
      };
    },
  };
}
