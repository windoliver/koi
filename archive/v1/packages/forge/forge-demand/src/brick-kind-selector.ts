/**
 * Brick-kind selector — maps forge demand triggers to suggested brick kinds.
 *
 * Replaces the hardcoded `suggestedBrickKind: "tool"` with a real selector
 * that considers the trigger kind and context.
 */

import type { BrickKind, ForgeTrigger } from "@koi/core";

/**
 * Result of brick kind selection. When `suppressed` is true, forge should
 * not be triggered for this signal (e.g., performance degradation should
 * be optimized, not forged).
 */
export type BrickKindSelection =
  | { readonly suppressed: false; readonly kind: BrickKind }
  | { readonly suppressed: true };

/**
 * Select the appropriate brick kind for a forge demand trigger.
 *
 * Mapping:
 * - repeated_failure → skill (teach the model a better approach)
 * - capability_gap → skill (instruct the model on handling the gap)
 * - no_matching_tool → skill (default) or tool (when explicitly executable)
 * - agent_capability_gap → agent
 * - agent_repeated_failure → agent
 * - performance_degradation → tool (optimization brick)
 * - agent_latency_degradation → suppress (optimize, don't forge)
 * - complex_task_completed → skill (save the approach)
 * - user_correction → skill (save the correction)
 * - novel_workflow → skill (save the workflow)
 */
export function selectBrickKind(trigger: ForgeTrigger): BrickKindSelection {
  switch (trigger.kind) {
    // Tool-level failure → teach the model a better approach
    case "repeated_failure":
    case "capability_gap":
      return { suppressed: false, kind: "skill" };

    // Missing tool → default to skill (instructions), not tool (code)
    // Rationale: most "missing tool" gaps can be addressed with better instructions
    // + existing tools. If truly needs code, the model can use forge_tool directly.
    case "no_matching_tool":
      return { suppressed: false, kind: "skill" };

    // Agent-level gaps → suggest an agent brick
    case "agent_capability_gap":
    case "agent_repeated_failure":
      return { suppressed: false, kind: "agent" };

    // Performance degradation → emit as tool (optimization brick)
    case "performance_degradation":
      return { suppressed: false, kind: "tool" };

    // Agent latency degradation → suppress forge, optimize instead
    case "agent_latency_degradation":
      return { suppressed: true };

    // Success-side signals → skill proposals (save learnings, not code)
    case "complex_task_completed":
    case "user_correction":
    case "novel_workflow":
      return { suppressed: false, kind: "skill" };

    // Data source signals → skill (data access patterns, not code)
    case "data_source_detected":
    case "data_source_gap":
      return { suppressed: false, kind: "skill" };

    default: {
      // Exhaustive check — TypeScript will error if a new trigger kind is added
      const _exhaustive: never = trigger;
      return _exhaustive;
    }
  }
}
