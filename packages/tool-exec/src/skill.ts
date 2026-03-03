/**
 * Skill component for the exec tool — teaches agents when and how to run code in a sandbox.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const EXEC_SKILL_NAME = "exec-guide" as const;

/**
 * Markdown content teaching agents when to use exec vs execute_script.
 * Injected into the agent's context alongside the tool descriptor.
 */
export const EXEC_SKILL_CONTENT: string = `
# exec — sandboxed code execution

## When to call exec

Use \`exec\` when you need to **compute, transform, or verify** data in isolation:

- **Math / data transforms**: aggregations, sorting, filtering, formatting that would be error-prone to do by hand
- **Input validation**: check user-provided data against schemas or constraints
- **Code verification**: run a snippet to confirm it produces the expected output
- **JSON reshaping**: transform API responses or config objects into a different structure

Pass structured data via the \`input\` parameter — the code receives it as the \`input\` variable
and returns a result.

## When NOT to call exec

- **Orchestrating tool calls**: use \`execute_script\` instead — it has \`callTool()\` bridging
- **Simple questions**: if you can answer directly without running code, just answer
- **File I/O or network**: exec runs in an isolated sandbox with no filesystem or network access (unless explicitly configured)

## exec vs execute_script

| | exec | execute_script |
|---|---|---|
| Purpose | Compute / transform / verify | Orchestrate multiple tool calls |
| Sandbox | Any backend (Docker, cloud, OS) | QuickJS Wasm (fixed) |
| Tool bridging | No | Yes (\`callTool()\`) |
| Data input | JSON via \`input\` param | None |
| Console capture | No | Yes |

## Example calls

\`\`\`json
{
  "code": "return input.prices.reduce((sum, p) => sum + p, 0)",
  "input": { "prices": [10, 20, 30] }
}
\`\`\`

\`\`\`json
{
  "code": "const sorted = [...input.items].sort((a, b) => b.score - a.score); return sorted.slice(0, 3);",
  "input": { "items": [{ "name": "a", "score": 5 }, { "name": "b", "score": 9 }, { "name": "c", "score": 2 }] }
}
\`\`\`

## Timeout

Default: 5 seconds. Max: 30 seconds. Pass \`timeout_ms\` for long-running computations.
Values above the server max are clamped silently.
`.trim();

/**
 * Pre-built SkillComponent for exec behavioral guidance.
 * Attached automatically by createExecProvider alongside the tool.
 */
export const EXEC_SKILL: SkillComponent = {
  name: EXEC_SKILL_NAME,
  description:
    "When to use exec for sandboxed computation vs execute_script for tool orchestration",
  content: EXEC_SKILL_CONTENT,
  tags: ["sandbox", "code-execution", "compute"],
} as const satisfies SkillComponent;
