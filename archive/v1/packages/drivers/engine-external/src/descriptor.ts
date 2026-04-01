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
import { validateExternalAdapterConfig } from "./validate-config.js";

const EXTERNAL_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-external-guide",
  description: "When to use engine: external",
  tags: ["engine", "cli", "subprocess", "external"],
  content: `# Engine: external

## When to use
- Wrapping interactive CLI agents (Claude CLI, Codex, Gemini, Aider)
- Running arbitrary CLI subprocess as an agent engine
- Non-ACP tools that communicate via stdin/stdout
- Shell scripts, Python scripts, or any executable

## Manifest examples

### Default (PTY mode — interactive CLI agents)
\`\`\`yaml
engine:
  name: external
  options:
    command: "claude"
    args: ["--no-ui"]
    pty:
      idleThresholdMs: 10000
      promptPattern: "\\\\$ $"
\`\`\`

### Single-shot mode (simple scripts)
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
- \`mode\` ("pty" | "single-shot" | "long-lived"): Process lifecycle mode (default: "pty")
- \`timeoutMs\` (number): Overall process timeout
- \`noOutputTimeoutMs\` (number): Timeout when no output is received
- \`maxOutputBytes\` (number): Maximum output size before truncation
- \`pty.idleThresholdMs\` (number): Silence threshold before turn completes (default: 30000)
- \`pty.ansiStrip\` (boolean): Strip ANSI escape codes from output (default: true)
- \`pty.cols\` (number): Terminal columns (default: 120)
- \`pty.rows\` (number): Terminal rows (default: 40)
- \`pty.promptPattern\` (string): Regex for fast-path prompt detection

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
    const result = validateExternalAdapterConfig(options);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return createExternalAdapter(result.value);
  },
};
