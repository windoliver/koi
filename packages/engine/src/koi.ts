/**
 * createKoi() — the primary factory for assembling and running an agent.
 *
 * Orchestrates: assembly → guard creation → middleware composition → runtime.
 */

import type {
  EngineEvent,
  EngineInput,
  KoiMiddleware,
  ProcessId,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, toolToken } from "@koi/core";
import { AgentEntity } from "./agent-entity.js";
import { createComposedCallHandlers, runSessionHooks, runTurnHooks } from "./compose.js";
import { KoiEngineError } from "./errors.js";
import { createIterationGuard, createLoopDetector, createSpawnGuard } from "./guards.js";
import type { CreateKoiOptions, KoiRuntime } from "./types.js";

/** Generate a unique process ID for a new agent. */
function generatePid(manifest: CreateKoiOptions["manifest"]): ProcessId {
  return {
    id: agentId(crypto.randomUUID()),
    name: manifest.name,
    type: "copilot",
    depth: 0,
  };
}

/** Sort middleware by priority (ascending). Guards get low numbers, L2 middleware gets higher. */
function sortByPriority(middleware: readonly KoiMiddleware[]): readonly KoiMiddleware[] {
  return [...middleware].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

export async function createKoi(options: CreateKoiOptions): Promise<KoiRuntime> {
  const { manifest, adapter, middleware = [], providers = [] } = options;

  // --- 1. Assemble the agent entity ---
  const pid = generatePid(manifest);
  const agent = await AgentEntity.assemble(pid, manifest, providers);

  // --- 2. Create L1 guards ---
  const guards: KoiMiddleware[] = [createIterationGuard(options.limits)];

  if (options.loopDetection !== false) {
    guards.push(
      createLoopDetector(options.loopDetection === undefined ? undefined : options.loopDetection),
    );
  }

  guards.push(createSpawnGuard(options.spawn, pid.depth, options.processAccounter));

  // --- 3. Compose middleware chain: guards + user middleware, sorted by priority ---
  const allMiddleware: readonly KoiMiddleware[] = sortByPriority([...guards, ...middleware]);

  // --- 4. Default tool terminal (looks up tools from agent components via O(1) token) ---
  const defaultToolTerminal = async (request: ToolRequest): Promise<ToolResponse> => {
    const tool = agent.component(toolToken(request.toolId));
    if (tool === undefined) {
      throw KoiEngineError.from("NOT_FOUND", `Tool not found: "${request.toolId}"`, {
        context: { toolId: request.toolId },
      });
    }
    const output = await tool.execute(request.input);
    return request.metadata !== undefined ? { output, metadata: request.metadata } : { output };
  };

  // --- 5. Track disposal and concurrency ---
  let disposed = false;
  let running = false;

  // --- 6. Build runtime ---
  const runtime: KoiRuntime = {
    agent,

    run(input: EngineInput): AsyncIterable<EngineEvent> {
      // Guard concurrent run() calls
      if (running) {
        throw KoiEngineError.from("VALIDATION", "Agent is already running");
      }

      return {
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          const gen = runGenerator(input);
          return {
            next: () => gen.next(),
            return: (value?: unknown) => gen.return(value as EngineEvent),
          };
        },
      };
    },

    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await adapter.dispose?.();
    },
  };

  async function* runGenerator(input: EngineInput): AsyncGenerator<EngineEvent> {
    running = true;
    let completed = false; // let justified: tracks whether generator completed or was interrupted
    const sessionStartedAt = Date.now();
    let currentTurnIndex = 0; // let justified: updated on turn_end events

    const sessionCtx = {
      agentId: pid.id,
      sessionId: crypto.randomUUID(),
      metadata: {},
    };

    agent.transition({ kind: "start" });
    await runSessionHooks(allMiddleware, "onSessionStart", sessionCtx);

    // Wire terminals → middleware → callHandlers if adapter is cooperating
    let effectiveInput = input;
    if (adapter.terminals) {
      const inputMessages = input.kind === "messages" ? input.messages : [];
      const getTurnContext = () => {
        const base = {
          session: sessionCtx,
          turnIndex: currentTurnIndex,
          messages: inputMessages,
          metadata: {},
        };
        return options.approvalHandler !== undefined
          ? { ...base, requestApproval: options.approvalHandler }
          : base;
      };
      const rawModelTerminal = adapter.terminals.modelCall;
      const rawToolTerminal = adapter.terminals.toolCall ?? defaultToolTerminal;
      const rawModelStreamTerminal = adapter.terminals.modelStream;
      const callHandlers = createComposedCallHandlers(
        allMiddleware,
        getTurnContext,
        agent,
        rawModelTerminal,
        rawToolTerminal,
        rawModelStreamTerminal,
      );
      effectiveInput = { ...input, callHandlers };
    }

    // Fire onBeforeTurn for turn 0
    await runTurnHooks(allMiddleware, "onBeforeTurn", {
      session: sessionCtx,
      turnIndex: currentTurnIndex,
      messages: [],
      metadata: {},
      ...(options.approvalHandler !== undefined
        ? { requestApproval: options.approvalHandler }
        : {}),
    });

    try {
      for await (const event of adapter.stream(effectiveInput)) {
        // Process turn_end events
        if (event.kind === "turn_end") {
          currentTurnIndex = event.turnIndex + 1;
          const turnCtx = {
            session: sessionCtx,
            turnIndex: event.turnIndex,
            messages: [],
            metadata: {},
            ...(options.approvalHandler !== undefined
              ? { requestApproval: options.approvalHandler }
              : {}),
          };
          await runTurnHooks(allMiddleware, "onAfterTurn", turnCtx);

          yield event;

          // Fire onBeforeTurn for the next turn
          await runTurnHooks(allMiddleware, "onBeforeTurn", {
            session: sessionCtx,
            turnIndex: currentTurnIndex,
            messages: [],
            metadata: {},
            ...(options.approvalHandler !== undefined
              ? { requestApproval: options.approvalHandler }
              : {}),
          });

          continue;
        }

        // Process done events
        if (event.kind === "done") {
          agent.transition({
            kind: "complete",
            stopReason: event.output.stopReason,
            metrics: event.output.metrics,
          });
          completed = true;
          yield event;
          return;
        }

        yield event;
      }

      // Stream ended without done event
      agent.transition({ kind: "complete", stopReason: "completed" });
      completed = true;
    } catch (error: unknown) {
      completed = true;

      // If it's a guard error, convert to a done event
      if (error instanceof KoiEngineError) {
        const stopReason = error.code === "TIMEOUT" ? "max_turns" : "error";
        agent.transition({ kind: "complete", stopReason });
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason,
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: 0,
              durationMs: Date.now() - sessionStartedAt,
            },
          },
        };
        return;
      }

      // Re-throw unexpected errors
      agent.transition({ kind: "error", error });
      throw error;
    } finally {
      // If generator was interrupted (break/return from consumer), transition to terminated
      if (!completed) {
        agent.transition({ kind: "complete", stopReason: "interrupted" });
      }

      try {
        await runSessionHooks(allMiddleware, "onSessionEnd", sessionCtx);
      } catch {
        // Don't mask original error — onSessionEnd failure must not override thrown error
      }
      running = false;
    }
  }

  return runtime;
}
