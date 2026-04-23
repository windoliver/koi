import type { ToolsetDefinition } from "@koi/core";

export const BUILTIN_TOOLSETS: readonly ToolsetDefinition[] = [
  {
    name: "safe",
    description: "No shell, no file write — safe for untrusted channels",
    tools: ["web_search", "web_fetch", "memory_read", "memory_write", "memory_delete"],
    includes: [],
  },
  {
    name: "developer",
    description: "Full tool access for coding agents",
    tools: ["*"],
    includes: [],
  },
  {
    name: "researcher",
    description: "Research without mutation — web, memory, and read-only filesystem",
    tools: [
      "web_search",
      "web_fetch",
      "memory_read",
      "memory_write",
      "memory_delete",
      "read_file",
      "glob",
      "grep",
    ],
    includes: [],
  },
  {
    name: "minimal",
    description: "Conversation only — memory and user interaction",
    tools: ["memory_read", "memory_write", "memory_delete", "ask_user"],
    includes: [],
  },
];
