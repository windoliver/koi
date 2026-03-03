/**
 * BrickDescriptor for @koi/engine-acp.
 *
 * Enables manifest-based auto-resolution for ACP-compatible agents.
 * Requires a `command` field in the engine options.
 */

import type { CompanionSkillDefinition, EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createAcpAdapter } from "./adapter.js";
import type { AcpAdapterConfig } from "./types.js";

const ACP_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-acp-guide",
  description: "When to use engine: acp",
  tags: ["engine", "acp", "cli-agent", "json-rpc", "coding-agent"],
  content: `# Engine: acp

## When to use
- Delegating to ACP-compatible coding agents (Claude Code, Codex, Gemini CLI)
- Tasks requiring file editing, code generation, or repository manipulation
- When you need a full coding agent with its own tool set
- JSON-RPC communication over stdin/stdout with an external agent process

## Manifest example
\`\`\`yaml
engine:
  name: acp
  options:
    command: "claude"
    args: ["--model", "claude-sonnet-4-5-20250929"]
    cwd: "/path/to/project"
\`\`\`

## Required options
- \`command\` (string): CLI command to spawn the ACP agent

## Optional options
- \`args\` (string[]): Arguments passed to the command
- \`cwd\` (string): Working directory for the agent process
- \`timeoutMs\` (number): Timeout for the agent process

## When NOT to use
- For direct model API access (use \`pi\` instead)
- For non-ACP CLI tools (use \`external\` instead)
- For simple tasks that don't need a full coding agent (use \`loop\`)
`,
};

function validateAcpEngineOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "ACP engine");
  if (!base.ok) return base;
  const opts = base.value;

  if (typeof opts.command !== "string" || opts.command === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "acp.command is required and must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for the ACP engine adapter.
 * Registered under the name "@koi/engine-acp" with alias "acp".
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-acp",
  aliases: ["acp"],
  description: "ACP protocol engine for Claude Code, Codex, and Gemini CLI agents",
  tags: ["acp", "cli-agent", "json-rpc", "coding-agent"],
  companionSkills: [ACP_COMPANION_SKILL],
  optionsValidator: validateAcpEngineOptions,
  factory(options): EngineAdapter {
    const command = options.command;
    if (typeof command !== "string") {
      throw new Error("acp.command is required");
    }

    const config: AcpAdapterConfig = {
      command,
      ...(Array.isArray(options.args) ? { args: options.args as readonly string[] } : {}),
      ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
    };

    return createAcpAdapter(config);
  },
};
