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

// Tools that golden query tests validate (interaction + task + spawn).
// EnterPlanMode, ExitPlanMode, and AskUserQuestion are intentionally excluded:
// they are NOT registered in the TUI until real UI dialogs exist (tracked in
// #1582). EnterPlanMode/ExitPlanMode only flip a boolean without gating
// Bash/fs access, and AskUserQuestion auto-answers the first option without
// showing the user the question.
export const GOLDEN_INTERACTION_TOOLS = ["TodoWrite"] as const;

export const GOLDEN_TASK_TOOLS = ["task_create", "task_delegate"] as const;

// agent_spawn is intentionally NOT in TUI until workers route through createKoi
// with full middleware (Bash, web_fetch, exfiltration guard, permissions) — tracked in #1582.
// Without createKoi, child workers only have Glob/Grep (read-only) but the prompt
// says "write files, run commands", causing misleading ok:true responses.
export const GOLDEN_SPAWN_TOOLS: readonly string[] = [] as const;

export const ALL_GOLDEN_TOOLS = [
  ...GOLDEN_INTERACTION_TOOLS,
  ...GOLDEN_TASK_TOOLS,
  ...GOLDEN_SPAWN_TOOLS,
] as const;

export const TUI_TOOL_WIRING_SOURCES = [
  "packages/meta/cli/src/tui-command.ts",
  "packages/meta/cli/src/runtime-factory.ts",
  "packages/meta/cli/src/preset-stacks/execution.ts",
] as const;

export function findMissingGoldenTools(
  sourceText: string,
  tools: readonly string[] = ALL_GOLDEN_TOOLS,
): string[] {
  const missing: string[] = [];
  for (const tool of tools) {
    // Check if the tool name appears in the TUI wiring source (either as a string
    // literal or as part of a descriptor/tool reference). This catches direct
    // tool construction and provider-based preset wiring.
    if (!sourceText.includes(tool)) {
      missing.push(tool);
    }
  }
  return missing;
}

function readTuiWiringSource(): string {
  return TUI_TOOL_WIRING_SOURCES.map((path) => readFileSync(path, "utf-8")).join("\n");
}

export interface CheckTuiToolsCliIo {
  readonly sourceText?: string | undefined;
  readonly stdout?: ((message: string) => void) | undefined;
  readonly stderr?: ((message: string) => void) | undefined;
  readonly exit?: ((code: number) => never) | undefined;
}

export function formatMissingGoldenToolsMessage(missing: readonly string[]): string {
  return (
    `❌ TUI is missing ${missing.length} golden query tool(s):\n\n` +
    missing.map((tool) => `  • ${tool}`).join("\n") +
    "\n\nFix: wire the missing tools in the TUI runtime wiring sources:\n" +
    TUI_TOOL_WIRING_SOURCES.map((path) => `  - ${path}`).join("\n") +
    "\nSee packages/meta/runtime/scripts/record-cassettes.ts for the golden query config.\n" +
    "Track: https://github.com/windoliver/koi/issues/TBD (migrate TUI to createKoi)\n"
  );
}

export function runCheckTuiToolsCli(io: CheckTuiToolsCliIo = {}): void {
  const missing = findMissingGoldenTools(io.sourceText ?? readTuiWiringSource());
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  const exit =
    io.exit ??
    ((code: number): never => {
      process.exit(code);
    });

  if (missing.length > 0) {
    stderr(formatMissingGoldenToolsMessage(missing));
    exit(1);
  }

  stdout(`✅ TUI has all ${ALL_GOLDEN_TOOLS.length} golden query tools wired.`);
}

if (import.meta.main) {
  runCheckTuiToolsCli();
}
