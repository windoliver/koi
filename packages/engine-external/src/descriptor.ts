/**
 * BrickDescriptor for @koi/engine-external.
 *
 * Enables manifest auto-resolution for external CLI process engines.
 * Passes through `command`, `args`, `cwd`, `mode`, `timeoutMs`,
 * `noOutputTimeoutMs`, and `maxOutputBytes` from YAML options.
 */

import type { CompanionSkillDefinition, EngineAdapter, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { createExternalAdapter } from "./adapter.js";
import type { ExternalAdapterConfig } from "./types.js";

const EXTERNAL_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-external-guide",
  description: "When to use engine: external",
  tags: ["engine", "cli", "subprocess", "external"],
  content: `# Engine: external

## When to use
- Running arbitrary CLI subprocess as an agent engine
- Non-ACP tools that communicate via stdin/stdout
- Single-shot or long-lived external processes
- Shell scripts, Python scripts, or any executable

## Manifest example
\`\`\`yaml
engine:
  name: external
  options:
    command: "python"
    args: ["agent.py"]
    mode: "single-shot"
    timeoutMs: 30000
\`\`\`

## Required options
- \`command\` (string): CLI command to spawn

## Optional options
- \`args\` (string[]): Arguments passed to the command
- \`cwd\` (string): Working directory for the process
- \`mode\` ("single-shot" | "long-lived"): Process lifecycle mode
- \`timeoutMs\` (number): Overall process timeout
- \`noOutputTimeoutMs\` (number): Timeout when no output is received
- \`maxOutputBytes\` (number): Maximum output size before truncation

## When NOT to use
- For ACP-compatible agents like Claude Code (use \`acp\` instead)
- For direct model API access (use \`pi\` instead)
- For Koi's built-in loop (use \`loop\` instead)
`,
};

function validateExternalEngineOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "External engine");
  if (!base.ok) return base;
  const opts = base.value;

  if (typeof opts.command !== "string" || opts.command === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "external.command is required and must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: opts };
}

/**
 * Descriptor for external engine adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-external",
  aliases: ["external"],
  description: "Arbitrary CLI subprocess engine for external tools",
  tags: ["cli", "subprocess", "external"],
  companionSkills: [EXTERNAL_COMPANION_SKILL],
  optionsValidator: validateExternalEngineOptions,
  factory(options): EngineAdapter {
    const command = options.command;
    if (typeof command !== "string") {
      throw new Error("external.command is required");
    }

    const config: ExternalAdapterConfig = {
      command,
      ...(Array.isArray(options.args) ? { args: options.args as readonly string[] } : {}),
      ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
      ...(options.mode === "single-shot" || options.mode === "long-lived"
        ? { mode: options.mode }
        : {}),
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
      ...(typeof options.noOutputTimeoutMs === "number"
        ? { noOutputTimeoutMs: options.noOutputTimeoutMs }
        : {}),
      ...(typeof options.maxOutputBytes === "number"
        ? { maxOutputBytes: options.maxOutputBytes }
        : {}),
    };

    return createExternalAdapter(config);
  },
};
