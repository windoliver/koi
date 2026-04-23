import type { ToolsetDefinition } from "@koi/core";

/**
 * Built-in toolset presets using Koi's primordial tool names (PascalCase convention).
 *
 * Tool names here must match the names registered by the tool packages at runtime.
 * Primordial built-ins: Bash, Glob, Grep, Read, Write, Edit, AskUserQuestion, TodoWrite,
 * EnterPlanMode, ExitPlanMode, ToolSearch.
 * Web tools (from @koi/tools-web with prefix "web"): web_search, web_fetch.
 *
 * Operators providing custom tools via MCP or forged tools must extend the registry
 * with their own presets — builtin names will not match custom tool registrations.
 *
 * Tool validation against the live registry is an assembly-time responsibility,
 * not a resolver responsibility: resolveToolset operates only on names.
 */
export const BUILTIN_TOOLSETS: readonly ToolsetDefinition[] = [
  {
    name: "safe",
    description:
      "Read-only research — web and filesystem, no shell, no writes (safe for untrusted channels)",
    tools: ["web_search", "web_fetch", "Glob", "Grep", "Read"],
    includes: [],
  },
  {
    name: "developer",
    description: "Full tool access for coding agents — resolves to mode:all (no filter)",
    tools: ["*"],
    includes: [],
  },
  {
    name: "researcher",
    description: "Research without mutation — web, read-only filesystem, and tool discovery",
    tools: ["web_search", "web_fetch", "Glob", "Grep", "Read", "ToolSearch"],
    includes: [],
  },
  {
    name: "minimal",
    description: "Conversation only — user interaction with no tool access beyond asking",
    tools: ["AskUserQuestion"],
    includes: [],
  },
];
