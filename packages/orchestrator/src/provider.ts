/**
 * ComponentProvider that attaches the 4 orchestrator tools to an agent.
 */

import type { Agent, ComponentProvider, TaskBoard } from "@koi/core";
import { skillToken } from "@koi/core";
import { executeAssignWorker } from "./assign-worker-tool.js";
import { createTaskBoard } from "./board.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import { executeOrchestrate } from "./orchestrate-tool.js";
import { executeReviewOutput } from "./review-output-tool.js";
import { ORCHESTRATOR_SKILL, ORCHESTRATOR_SKILL_NAME } from "./skill.js";
import { executeSynthesize } from "./synthesize-tool.js";
import type { OrchestratorConfig } from "./types.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "./types.js";

/**
 * Creates a ComponentProvider that attaches 4 orchestrator tools.
 *
 * The tools share a board holder — the board itself is immutable,
 * but the "current board" reference updates on each mutation.
 */
export function createOrchestratorProvider(config: OrchestratorConfig): ComponentProvider {
  // let justified: mutable cache (set once on first attach)
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "orchestrator",

    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      if (cached !== undefined) return cached;

      // Mutable holder for the current immutable board
      // let justified: board reference changes on each mutation
      let currentBoard: TaskBoard = createTaskBoard({
        maxRetries: config.maxRetries ?? DEFAULT_ORCHESTRATOR_CONFIG.maxRetries,
        onEvent: config.onEvent,
      });

      const holder: BoardHolder = {
        getBoard: () => currentBoard,
        setBoard: (board: TaskBoard) => {
          currentBoard = board;
        },
      };

      const controller = new AbortController();
      const maxDurationMs = config.maxDurationMs ?? DEFAULT_ORCHESTRATOR_CONFIG.maxDurationMs;
      const timeoutHandle = setTimeout(
        () => controller.abort("orchestration timeout"),
        maxDurationMs,
      );
      // Clear timeout if the controller is already aborted externally
      controller.signal.addEventListener("abort", () => clearTimeout(timeoutHandle), {
        once: true,
      });

      const maxOutput = config.maxOutputPerTask ?? DEFAULT_ORCHESTRATOR_CONFIG.maxOutputPerTask;

      const components = new Map<string, unknown>();

      components.set("tool:orchestrate", {
        name: "orchestrate",
        execute: (input: unknown) => executeOrchestrate(input, holder),
      });

      components.set("tool:assign_worker", {
        name: "assign_worker",
        execute: (input: unknown) => executeAssignWorker(input, holder, config, controller.signal),
      });

      components.set("tool:review_output", {
        name: "review_output",
        execute: (input: unknown) => executeReviewOutput(input, holder),
      });

      components.set("tool:synthesize", {
        name: "synthesize",
        execute: (input: unknown) => executeSynthesize(input, holder, maxOutput),
      });

      components.set(skillToken(ORCHESTRATOR_SKILL_NAME) as string, ORCHESTRATOR_SKILL);

      cached = components;
      return cached;
    },
  };
}
