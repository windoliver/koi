/**
 * Companion skill — teaches the LLM when/how to use agent spawning.
 */

import type { AttachResult, CompanionSkillDefinition, ComponentProvider } from "@koi/core";
import { skillToken } from "@koi/core";

/** Well-known skill token for agent spawning. */
const SPAWNER_SKILL_TOKEN = skillToken("agent-spawner");

/** Static skill definition describing agent spawning capabilities. */
export const AGENT_SPAWNER_SKILL: CompanionSkillDefinition = {
  name: "agent-spawner",
  description: "Spawn external coding agents in sandboxed containers",
  content: [
    "# Agent Spawner",
    "",
    "Delegates coding tasks to external agents (Claude Code, Codex, Aider, Gemini CLI)",
    "running inside sandboxed containers.",
    "",
    "## Protocols",
    "",
    "- **acp**: JSON-RPC communication via ACP (Agent Communication Protocol).",
    "  Used by Claude Code, Codex, and Gemini CLI.",
    "- **stdio**: Raw stdin/stdout with `--print` flag.",
    "  Used by Aider and OpenCode.",
    "",
    "## Usage",
    "",
    "The spawner is injected via `AgentSpawnerConfig` and exposes `spawn(agent, prompt, options?)`.",
    "Returns `Result<string, KoiError>` with the agent's text output.",
    "",
    "## Error Classification",
    "",
    "- `SPAWN_FAILED` — container or process creation failed (retryable)",
    "- `PARSE_FAILED` — output parsing failed (not retryable)",
    "- `TIMEOUT` — agent exceeded time limit (retryable)",
  ].join("\n"),
  tags: ["delegation", "sandbox", "acp", "stdio"],
};

/**
 * Create a ComponentProvider that attaches the agent-spawner companion skill.
 */
export function createAgentSpawnerSkillProvider(): ComponentProvider {
  return {
    name: "agent-spawner-skill",

    attach: async (): Promise<AttachResult> => {
      const components = new Map<string, unknown>();
      components.set(SPAWNER_SKILL_TOKEN, {
        name: AGENT_SPAWNER_SKILL.name,
        description: AGENT_SPAWNER_SKILL.description,
        content: AGENT_SPAWNER_SKILL.content,
        tags: AGENT_SPAWNER_SKILL.tags,
      });
      return { components, skipped: [] };
    },
  };
}
