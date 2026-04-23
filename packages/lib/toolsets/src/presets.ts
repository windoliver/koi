import type { ToolsetDefinition } from "@koi/core";

export const BUILTIN_TOOLSETS: readonly ToolsetDefinition[] = [
  {
    name: "safe",
    description:
      "Read-only web + memory — safe for untrusted channels (no shell, no writes, no deletes)",
    tools: ["web_search", "web_fetch", "memory_read"],
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
    description: "Research without mutation — read-only web, memory, and filesystem",
    tools: ["web_search", "web_fetch", "memory_read", "read_file", "glob", "grep"],
    includes: [],
  },
  {
    name: "minimal",
    description: "Conversation only — read-only memory and user interaction",
    tools: ["memory_read", "ask_user"],
    includes: [],
  },
];
