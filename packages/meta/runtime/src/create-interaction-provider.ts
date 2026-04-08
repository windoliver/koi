/**
 * createInteractionProvider — wires TodoWrite, EnterPlanMode, ExitPlanMode,
 * and AskUserQuestion into the ECS assembly.
 *
 * State is managed in-memory per provider instance (one per session):
 *   - Todo items: flat array, replaced on each TodoWrite call
 *   - Plan mode: boolean flag + in-memory plan content
 *
 * NOTE: Interaction state (todo list, plan mode flag, plan content) is ephemeral —
 * stored in closure locals, lost on process restart. Sessions resumed via --resume
 * will start with empty state. Persisting interaction state alongside the session
 * transcript is a future enhancement.
 *
 * The `elicit` callback must be provided by the caller (harness or CLI layer).
 * For CLI use: wire it to the TUI dialog or a readline prompt.
 * For tests: wire it to a mock that returns pre-canned answers.
 *
 * EnterPlanMode is main-thread only — spawned agents must NOT receive this
 * provider. Pass `isAgentContext: () => true` to explicitly block it, or
 * simply omit the provider when assembling spawned agents.
 */

import type { ComponentProvider, ElicitationQuestion, ElicitationResult } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, type ToolPolicy } from "@koi/core";
import {
  createAskUserTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createTodoTool,
  type TodoItem,
} from "@koi/tools-builtin";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InteractionProviderConfig {
  /**
   * Elicitation callback — called by AskUserQuestion to pause the agent and
   * present structured questions to the user.
   *
   * Implementations:
   *   - CLI/TUI: render a dialog, resolve when the user submits
   *   - Channel mode: MUST NOT be provided (omit to disable AskUserQuestion)
   *   - Tests: mock that returns pre-canned ElicitationResult[]
   */
  readonly elicit?:
    | ((questions: readonly ElicitationQuestion[]) => Promise<readonly ElicitationResult[]>)
    | undefined;

  /**
   * Returns true when the agent is running in channel mode (Telegram, Discord, etc.)
   * where no TUI dialog is available. Disables AskUserQuestion and plan-mode tools.
   */
  readonly isChannelsActive?: (() => boolean) | undefined;

  /**
   * Override plan content persistence. When provided, ExitPlanMode calls this
   * instead of holding plan content in memory (e.g., to write to disk).
   */
  readonly savePlanContent?: ((content: string) => Promise<void>) | undefined;

  /**
   * Read persisted plan content. Paired with savePlanContent.
   * When omitted, ExitPlanMode reads from the in-memory store.
   */
  readonly getPlanContent?: (() => Promise<string | undefined>) | undefined;

  /**
   * Returns the plan file path for display in tool results.
   * Optional — omit for in-memory only.
   */
  readonly getPlanFilePath?: (() => string | undefined) | undefined;

  /**
   * Returns true when the provider is attached to a spawned agent context.
   * When true, EnterPlanMode calls are blocked with FORBIDDEN.
   *
   * Default: `() => false` (main-thread assumed).
   * Callers that supply this provider to child agents MUST override this
   * to return true, otherwise children can incorrectly enter plan mode.
   */
  readonly isAgentContext?: (() => boolean) | undefined;

  /**
   * Called when the agent enters plan mode. Wire this to the harness
   * permission backend to enforce the read-only gate (e.g., switch the
   * active permission mode to 'plan' so Write/Edit/Bash calls are denied).
   *
   * Default: noop (permission enforcement must be provided by the harness).
   */
  readonly onEnterPlanMode?: (() => void) | undefined;

  /**
   * Called when the agent exits plan mode (plan approved). Wire this to
   * the harness permission backend to restore pre-plan permissions and
   * optionally apply the `allowedPrompts` from the approved plan.
   *
   * @param allowedPrompts - Semantic Bash-permission requests from the plan.
   *
   * Default: noop (permission restoration must be provided by the harness).
   */
  readonly onExitPlanMode?: ((allowedPrompts: readonly unknown[]) => void) | undefined;

  readonly policy?: ToolPolicy | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInteractionProvider(
  config: InteractionProviderConfig = {},
): ComponentProvider {
  const {
    elicit,
    isChannelsActive,
    savePlanContent,
    getPlanContent,
    getPlanFilePath,
    isAgentContext = () => false,
    onEnterPlanMode,
    onExitPlanMode,
    policy = DEFAULT_UNSANDBOXED_POLICY,
  } = config;

  return {
    name: "interaction",
    async attach(_agent): Promise<ReadonlyMap<string, unknown>> {
      // --- In-memory state (per agent — fresh on every attach) ---
      // Each agent that receives this provider gets its own isolated state.
      // This prevents a spawned child from mutating the parent's todo list,
      // plan mode flag, or plan content through shared closures.
      //
      // IMPORTANT: This isolation only holds when the engine calls attach()
      // for each child agent independently. If the engine copies the parent's
      // assembled component map into children by reference (without re-running
      // providers), children will share tool instances and can mutate parent
      // state. The engine MUST NOT provide this provider to spawned children —
      // omit it from child assembly or pass isAgentContext: () => true.

      // let: mutable todo list, replaced atomically on each write
      let todoItems: readonly TodoItem[] = [];

      // let: mutable plan mode flag
      let inPlanMode = false;

      // let: mutable plan content (in-memory fallback when no savePlanContent)
      let planContentMemory: string | undefined;

      // --- Build tools ---

      const todoTool = createTodoTool({
        getItems: () => todoItems,
        setItems: (items) => {
          todoItems = items;
        },
        policy,
      });

      const enterPlanModeTool = createEnterPlanModeTool({
        // Use caller-supplied isAgentContext — defaults to () => false (main thread).
        // Callers that wire this provider to spawned agents MUST pass
        // isAgentContext: () => true to block plan-mode entry in children.
        isAgentContext,
        isInPlanMode: () => inPlanMode,
        enterPlanMode: () => {
          inPlanMode = true;
          // Hook: caller can switch the harness permission mode to enforce
          // the read-only gate (deny Write/Edit/Bash until plan is approved).
          onEnterPlanMode?.();
        },
        isChannelsActive,
        policy,
      });

      const exitPlanModeTool = createExitPlanModeTool({
        isInPlanMode: () => inPlanMode,
        // Swarm path: not wired here — belongs to @koi/swarm (#1416).
        // When swarm ships, extend this provider or create a SwarmInteractionProvider
        // that overrides isTeammate/isPlanModeRequired/writeToMailbox.
        isTeammate: false,
        isPlanModeRequired: false,
        exitPlanMode: () => {
          inPlanMode = false;
        },
        getPlanContent: getPlanContent ?? (async () => planContentMemory),
        savePlanContent:
          savePlanContent ??
          (async (content) => {
            planContentMemory = content;
          }),
        getPlanFilePath,
        isChannelsActive,
        // Hook: caller can restore pre-plan permissions and apply allowedPrompts.
        onApproved: onExitPlanMode,
        policy,
      });

      // AskUserQuestion is only included when elicit is wired.
      // Without it the tool is omitted entirely — the model won't see it.
      const askUserTool =
        elicit !== undefined ? createAskUserTool({ elicit, isChannelsActive, policy }) : undefined;

      const components = new Map<string, unknown>([
        ["tool:TodoWrite", todoTool],
        ["tool:EnterPlanMode", enterPlanModeTool],
        ["tool:ExitPlanMode", exitPlanModeTool],
      ]);
      if (askUserTool !== undefined) {
        components.set("tool:AskUserQuestion", askUserTool);
      }

      return components;
    },
  };
}
