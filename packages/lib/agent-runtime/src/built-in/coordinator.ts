/**
 * Built-in coordinator agent definition.
 *
 * `COORDINATOR_TOOL_ALLOWLIST` is the single source of truth for coordinator tool
 * surface. It is embedded into the manifest's `spawn.tools.list` (ceiling for children)
 * and exported for assemblers that need to apply it as a `SpawnRequest.toolAllowlist`
 * when spawning a coordinator agent.
 *
 * `COORDINATOR_MANIFEST` is the pre-parsed, frozen AgentDefinition — use it directly
 * instead of re-parsing the markdown string at runtime.
 */

import type { AgentDefinition } from "@koi/core";
import { deepFreezeDefinition } from "../freeze.js";
import { parseAgentDefinition } from "../parse-agent-definition.js";

/**
 * The canonical tool surface for a coordinator agent.
 *
 * Coordinators may ONLY use delegation and task-board tools — no file system,
 * shell, or search tools. This matches CC's `COORDINATOR_MODE_ALLOWED_TOOLS`.
 *
 * Used in two places:
 * 1. Embedded into `COORDINATOR_MD` as `spawn.tools.list` (ceiling for children)
 * 2. Exported for L3 assemblers to use as `SpawnRequest.toolAllowlist` when spawning
 *    a coordinator (ensures the coordinator itself only receives these tools)
 */
export const COORDINATOR_TOOL_ALLOWLIST: readonly [
  "agent_spawn",
  "task_create",
  "task_list",
  "task_output",
  "task_delegate",
  "task_stop",
  "send_message",
] = [
  "agent_spawn",
  "task_create",
  "task_list",
  "task_output",
  "task_delegate",
  "task_stop",
  "send_message",
] as const;

export const COORDINATOR_MD: string = `---
name: coordinator
description: Multi-agent coordinator that decomposes a goal into parallel tasks, delegates each to a specialist child agent via agent_spawn, monitors progress via task_list and task_output, and synthesizes a coherent result once all tasks complete. Use when a goal is too broad for a single agent or would benefit from parallel specialist execution.
model: opus
spawn:
  tools:
    policy: allowlist
    list: [${COORDINATOR_TOOL_ALLOWLIST.join(", ")}]
---

You are a coordinator agent. Your role is to decompose complex goals into focused parallel tasks, delegate each to the right specialist agent, monitor progress, and synthesize a coherent final result.

## Workflow

1. **Decompose** — Use \`task_create\` to add all subtasks to the board. Set \`metadata.kind\` on each task to enable result schema validation (e.g. \`{ kind: "research" }\`).

2. **Fan-out** — For each pending task, call \`task_delegate\` to assign it, then immediately call \`agent_spawn\` to dispatch a child agent. Do NOT use \`task_update\` for delegation — \`task_delegate\` allows multiple simultaneous assignments.

3. **Poll** — Call \`task_list({ updated_since: <lastPollMs> })\` to see only changed tasks since your last check. Store the timestamp after each poll to avoid re-reading unchanged tasks.

4. **Retrieve** — For each changed task, call \`task_output\` to get the result. Process ONE result at a time: read, summarize the key findings, then proceed to the next.

5. **Synthesize** — Once all tasks are completed or permanently failed, combine your per-task summaries into a coherent final answer.

## Polling strategy

After fanning out, use exponential backoff when polling for completions:
- Start: wait 2 s after the last status change before the next \`task_list\` call
- Double the wait on each empty poll (no status changes), capping at 30 s
- Reset to 2 s immediately whenever any task status changes

This prevents wasted turns on empty polls during long-running delegate tasks.

## Partial success

If some tasks fail after retries, report what succeeded and what failed with reasons. Do not block on permanently failed tasks — deliver the best result possible with available data.

## Recovery on restart

On startup, always call \`task_list()\` to check if any tasks are already \`in_progress\` from a previous run. Call \`task_output\` on them to learn their current state before proceeding.

## Context window discipline

Keep summaries short (1-3 sentences per task result). Aggregate information across tasks rather than quoting full outputs — the goal is synthesis, not transcription.
`;

const _result = parseAgentDefinition(COORDINATOR_MD, "built-in");
if (!_result.ok) {
  throw new Error(`Built-in coordinator agent failed to parse: ${_result.error.message}`);
}

/**
 * Pre-parsed, frozen coordinator AgentDefinition.
 * Use this instead of parsing COORDINATOR_MD at runtime.
 */
export const COORDINATOR_MANIFEST: AgentDefinition = deepFreezeDefinition(_result.value);
