/**
 * createInteractionProvider — wires TodoWrite, EnterPlanMode, ExitPlanMode,
 * and AskUserQuestion into the ECS assembly.
 *
 * State is managed in-memory per provider instance (one per session):
 *   - Todo items: flat array, replaced on each TodoWrite call
 *   - Plan mode: boolean flag + in-memory plan content
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
    policy = DEFAULT_UNSANDBOXED_POLICY,
  } = config;

  // --- In-memory state (per provider = per session) ---

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
    // This provider is for the main thread agent only.
    // Spawned agents must not receive it (configured at assembly time).
    isAgentContext: () => false,
    isInPlanMode: () => inPlanMode,
    enterPlanMode: () => {
      inPlanMode = true;
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
    policy,
  });

  // AskUserQuestion is only included when elicit is wired.
  // Without it the tool is omitted entirely — the model won't see it.
  const askUserTool =
    elicit !== undefined ? createAskUserTool({ elicit, isChannelsActive, policy }) : undefined;

  // --- ComponentProvider ---

  const components = new Map<string, unknown>([
    ["tool:TodoWrite", todoTool],
    ["tool:EnterPlanMode", enterPlanModeTool],
    ["tool:ExitPlanMode", exitPlanModeTool],
  ]);
  if (askUserTool !== undefined) {
    components.set("tool:AskUserQuestion", askUserTool);
  }

  return {
    name: "interaction",
    async attach(_agent): Promise<ReadonlyMap<string, unknown>> {
      return components;
    },
  };
}
