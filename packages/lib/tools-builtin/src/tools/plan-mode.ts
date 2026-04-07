/**
 * Tool factories for plan-mode: EnterPlanMode + ExitPlanMode.
 *
 * Plan mode is a conversational safety gate: the agent explores and designs
 * before writing any files. Enforcement is instructional (the tool result tells
 * the model what it can/cannot do) — the harness enforces the mode via
 * permission callbacks.
 *
 * EnterPlanMode:
 *   - Main thread only — throws if called from an agent context (agentId set)
 *   - Calls config.enterPlanMode() to set the permission mode in the harness
 *
 * ExitPlanMode:
 *   - Non-teammate: presents plan for user approval (permission behavior: 'ask')
 *   - Swarm teammate (isPlanModeRequired): writes plan_approval_request to team
 *     lead mailbox and returns awaitingLeaderApproval: true
 *   - Plan content persisted to disk via config.savePlanContent()
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Message written to the team lead's mailbox when a teammate exits plan mode. */
export interface PlanApprovalRequest {
  readonly type: "plan_approval_request";
  readonly from: string;
  readonly timestamp: string;
  readonly planFilePath: string | undefined;
  readonly planContent: string;
  readonly requestId: string;
}

export interface EnterPlanModeConfig {
  /** Returns true if this tool is being called from inside a spawned agent. */
  readonly isAgentContext: () => boolean;
  /** Returns true if the harness is already in plan mode. */
  readonly isInPlanMode: () => boolean;
  /** Transitions the harness permission mode to 'plan'. */
  readonly enterPlanMode: () => void;
  /** Disabled when channels are active (plan approval dialog needs TUI). */
  readonly isChannelsActive?: (() => boolean) | undefined;
  readonly policy?: ToolPolicy | undefined;
}

export interface ExitPlanModeConfig {
  /** Returns true if the harness is currently in plan mode. */
  readonly isInPlanMode: () => boolean;
  /** True when this agent is running as a teammate in a swarm. */
  readonly isTeammate: boolean;
  /** True when the teammate must have its plan approved by the team lead. */
  readonly isPlanModeRequired: boolean;
  /** Restores the pre-plan permission mode. */
  readonly exitPlanMode: () => void;
  /** Reads the current plan content (written by the model to its plan file). */
  readonly getPlanContent: () => Promise<string | undefined>;
  /** Persists plan content received from the web UI (CCR plan edit flow). */
  readonly savePlanContent?: ((content: string) => Promise<void>) | undefined;
  /** Plan file path — included in mailbox message and tool result. */
  readonly getPlanFilePath?: (() => string | undefined) | undefined;
  /**
   * Teammate name, used as the `from` field in the mailbox message.
   * Required when isTeammate && isPlanModeRequired.
   */
  readonly getAgentName?: (() => string) | undefined;
  /** Team name for mailbox routing. */
  readonly getTeamName?: (() => string | undefined) | undefined;
  /**
   * Write a message to a teammate's mailbox.
   * Required when isTeammate && isPlanModeRequired.
   */
  readonly writeToMailbox?:
    | ((
        recipient: "team-lead",
        message: { readonly from: string; readonly text: string; readonly timestamp: string },
        teamName: string | undefined,
      ) => Promise<void>)
    | undefined;
  /** Generate a unique request ID for plan approval tracking. */
  readonly generateRequestId?: (() => string) | undefined;
  /** Update the task's awaitingPlanApproval state (for in-process teammate UI). */
  readonly setAwaitingPlanApproval?: ((awaiting: boolean) => void) | undefined;
  /** True when the AgentTool (swarm) is available — hints at TeamCreateTool. */
  readonly hasTeamCreateTool?: (() => boolean) | undefined;
  readonly isChannelsActive?: (() => boolean) | undefined;
  readonly policy?: ToolPolicy | undefined;
}

// ---------------------------------------------------------------------------
// EnterPlanMode
// ---------------------------------------------------------------------------

export function createEnterPlanModeTool(config: EnterPlanModeConfig): Tool {
  const {
    isAgentContext,
    isInPlanMode,
    enterPlanMode,
    isChannelsActive,
    policy = DEFAULT_UNSANDBOXED_POLICY,
  } = config;

  return {
    descriptor: {
      name: "EnterPlanMode",
      description:
        "Switch to plan mode for complex tasks that require exploration and design " +
        "before any file changes. In plan mode you MUST NOT write or edit files — " +
        "only read, search, and explore. When ready, call ExitPlanMode to present " +
        "your plan for approval.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (_args: JsonObject): Promise<unknown> => {
      if (isAgentContext()) {
        return {
          error: "EnterPlanMode cannot be used inside a spawned agent context.",
          code: "FORBIDDEN",
        };
      }
      if (isChannelsActive?.() === true) {
        return {
          error:
            "EnterPlanMode is unavailable in channel mode — ExitPlanMode requires a TUI dialog. " +
            "Proceed directly with implementation.",
          code: "UNAVAILABLE",
        };
      }
      if (isInPlanMode()) {
        return {
          error: "Already in plan mode.",
          code: "CONFLICT",
        };
      }

      enterPlanMode();

      return {
        message:
          "Entered plan mode. Explore the codebase and design your approach.\n\n" +
          "In plan mode you should:\n" +
          "1. Read and search files to understand existing patterns\n" +
          "2. Identify similar features and architectural approaches\n" +
          "3. Consider trade-offs between multiple approaches\n" +
          "4. Use AskUserQuestion if you need to clarify the approach\n" +
          "5. When ready, call ExitPlanMode to present your plan\n\n" +
          "DO NOT write or edit any files yet.",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

export function createExitPlanModeTool(config: ExitPlanModeConfig): Tool {
  const {
    isInPlanMode,
    isTeammate,
    isPlanModeRequired,
    exitPlanMode,
    getPlanContent,
    savePlanContent,
    getPlanFilePath,
    getAgentName,
    getTeamName,
    writeToMailbox,
    generateRequestId,
    setAwaitingPlanApproval,
    hasTeamCreateTool,
    isChannelsActive,
    policy = DEFAULT_UNSANDBOXED_POLICY,
  } = config;

  return {
    descriptor: {
      name: "ExitPlanMode",
      description:
        "Present your completed plan and request approval to exit plan mode and begin " +
        "implementation. Call this only after you have written a thorough plan. " +
        "Pass your plan as plan_content — it is required and must be non-empty.",
      inputSchema: {
        type: "object",
        properties: {
          plan_content: {
            type: "string",
            description:
              "The full plan text to record and approve. Must be non-empty. " +
              "Summarize every step you intend to take before calling this tool.",
          },
          allowedPrompts: {
            type: "array",
            description:
              "Semantic permission requests needed to implement the plan (Bash tool only).",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", enum: ["Bash"] },
                prompt: {
                  type: "string",
                  description: "Semantic description, e.g. 'run tests', 'install dependencies'.",
                },
              },
              required: ["tool", "prompt"],
            },
          },
        },
        required: ["plan_content"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      if (isChannelsActive?.() === true) {
        return {
          error: "ExitPlanMode is unavailable in channel mode — the approval dialog requires TUI.",
          code: "UNAVAILABLE",
        };
      }
      if (!isInPlanMode()) {
        return {
          error:
            "Not in plan mode. If your plan was already approved, continue with implementation.",
          code: "CONFLICT",
        };
      }

      // Resolve plan: inline plan_content arg takes precedence over persisted state.
      const inlinePlan =
        typeof args.plan_content === "string" ? args.plan_content.trim() : undefined;
      const filePath = getPlanFilePath?.();
      const plan = inlinePlan ?? (await getPlanContent());

      // Require non-empty plan on all paths — teammate and main-thread alike.
      if (!plan || plan.trim().length === 0) {
        return {
          error:
            `No plan content found${filePath !== undefined ? ` at ${filePath}` : ""}. ` +
            "Pass your plan as plan_content or write it to the plan file before calling ExitPlanMode.",
          code: "NOT_FOUND",
        };
      }

      // --- Swarm teammate path: send plan_approval_request to team lead ---
      if (isTeammate && isPlanModeRequired) {
        if (!writeToMailbox) {
          return {
            error: "Mailbox not configured — cannot send plan approval request.",
            code: "INTERNAL",
          };
        }

        const agentName = getAgentName?.() ?? "unknown";
        const teamName = getTeamName?.();
        const requestId =
          generateRequestId?.() ?? `plan_approval_${agentName}_${Date.now().toString(36)}`;

        const approvalRequest: PlanApprovalRequest = {
          type: "plan_approval_request",
          from: agentName,
          timestamp: new Date().toISOString(),
          planFilePath: filePath,
          planContent: plan,
          requestId,
        };

        await writeToMailbox(
          "team-lead",
          {
            from: agentName,
            text: JSON.stringify(approvalRequest),
            timestamp: new Date().toISOString(),
          },
          teamName,
        );

        setAwaitingPlanApproval?.(true);

        return {
          awaitingLeaderApproval: true,
          requestId,
          filePath,
          message:
            "Your plan has been submitted to the team lead for approval.\n\n" +
            "**What happens next:**\n" +
            "1. Wait for the team lead to review your plan\n" +
            "2. You will receive a message in your inbox with approval/rejection\n" +
            "3. If approved, proceed with implementation\n" +
            "4. If rejected, refine your plan based on feedback\n\n" +
            "**Important:** Do NOT proceed until you receive approval. Check your inbox.",
        };
      }

      // --- Main thread / voluntary teammate path: restore mode ---
      if (savePlanContent !== undefined && plan !== undefined) {
        await savePlanContent(plan);
      }
      exitPlanMode();

      const teamHint =
        hasTeamCreateTool?.() === true
          ? "\n\nIf this plan can be broken down into independent tasks, consider using " +
            "TeamCreate to parallelize the work across teammates."
          : "";

      const planSection =
        plan !== undefined && plan.trim().length > 0 ? `\n\n## Approved Plan:\n${plan}` : "";

      return {
        approved: true,
        filePath,
        message:
          `Plan approved. You can now start coding. Update your todo list if applicable.${teamHint}` +
          (filePath !== undefined ? `\n\nPlan saved to: ${filePath}` : "") +
          planSection,
      };
    },
  };
}
