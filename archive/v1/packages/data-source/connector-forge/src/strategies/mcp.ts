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
      const toolName = descriptor.mcpToolName ?? descriptor.name;

      const body = [
        `# ${descriptor.name} — MCP Data Source`,
        "",
        descriptor.description ?? "Data access via MCP tool.",
        "",
        "## Usage",
        "",
        `Call the MCP tool \`${toolName}\` directly — it is already registered as a runtime tool.`,
        "Do NOT use `query_datasource` for MCP sources; invoke the tool by name instead.",
        "",
        "## Tool Reference",
        "",
        `- Tool name: \`${toolName}\``,
        `- Source: ${descriptor.name}`,
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
