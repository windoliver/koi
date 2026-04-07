/**
 * check-tui-tools — CI gate that verifies the TUI's tool registry includes
 * all interaction tools validated by golden query tests.
 *
 * Prevents tool drift: when a golden query adds a new tool, the TUI must
 * wire it too. Fails with a clear message listing missing tools.
 *
 * Usage: bun run scripts/check-tui-tools.ts
 */

import { readFileSync } from "node:fs";

// Tools that golden query tests validate (interaction + task + spawn)
const GOLDEN_INTERACTION_TOOLS = [
  "TodoWrite",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
] as const;

const GOLDEN_TASK_TOOLS = ["task_create", "task_delegate"] as const;

const GOLDEN_SPAWN_TOOLS = ["agent_spawn"] as const;

const ALL_GOLDEN_TOOLS = [
  ...GOLDEN_INTERACTION_TOOLS,
  ...GOLDEN_TASK_TOOLS,
  ...GOLDEN_SPAWN_TOOLS,
] as const;

// Read the TUI source and check for tool registration
const tuiSource = readFileSync("packages/meta/cli/src/tui-command.ts", "utf-8");

const missing: string[] = [];
for (const tool of ALL_GOLDEN_TOOLS) {
  // Check if the tool name appears in the TUI source (either as a string literal
  // or as part of a descriptor/tool reference). This is a simple grep — it catches
  // both direct tool construction and provider-based wiring.
  if (!tuiSource.includes(tool)) {
    missing.push(tool);
  }
}

if (missing.length > 0) {
  console.error(`❌ TUI is missing ${missing.length} golden query tool(s):\n`);
  for (const tool of missing) {
    console.error(`  • ${tool}`);
  }
  console.error(
    "\nFix: wire the missing tools in packages/meta/cli/src/tui-command.ts.\n" +
      "See packages/meta/runtime/scripts/record-cassettes.ts for the golden query config.\n" +
      "Track: https://github.com/windoliver/koi/issues/TBD (migrate TUI to createKoi)\n",
  );
  process.exit(1);
} else {
  console.log(`✅ TUI has all ${ALL_GOLDEN_TOOLS.length} golden query tools wired.`);
}
