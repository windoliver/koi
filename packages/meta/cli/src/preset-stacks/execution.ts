/**
 * Execution preset stack — shell execution + background task management.
 *
 * This is the stack that actually runs commands. It owns:
 *
 *   - OS sandbox adapter (seatbelt on macOS, bubblewrap on Linux) plus
 *     the restrictive profile with workspace/temp/cache write exceptions.
 *     When unavailable on the host, bash runs unsandboxed with only the
 *     @koi/bash-security denylist guard.
 *   - `createBashToolWithHooks` handle — CWD tracking, AST walker with
 *     `elicit` fallback routed to the caller's approval handler.
 *   - A mutable background-task AbortController rotated on session
 *     reset so prior-session subprocesses are killed but new tasks
 *     still get a fresh signal.
 *   - A live-subprocess counter incremented/decremented by onStart /
 *     onEnd callbacks; drives `hasActiveWork` and determines whether
 *     the host should wait for SIGKILL escalation on shutdown.
 *   - `ManagedTaskBoard` behind a Proxy over `boardRef.current` so
 *     cached tool providers transparently see a new board when the
 *     reference is swapped on session reset.
 *   - `bash_background` tool + `task_*` tool providers.
 *
 * The canonical `Bash` tool itself is NOT contributed here — it's wired
 * through `buildCoreProviders` so plain `koi start` gets shell access
 * too. The execution stack exports `bashHandle` so the factory can
 * pass `bashHandle.tool` into the core provider set.
 *
 * Exports:
 *   - `bashHandle`     — for factory → buildCoreProviders (core Bash)
 *                        and resetSessionState → bashHandle.resetCwd()
 *   - `sandboxActive`  — boolean shown in the TUI status bar
 *   - `getBgSignal`    — `() => AbortSignal` for legacy callers that
 *                        need the current controller's signal
 *   - `hasLiveProcesses` — `() => boolean` shortcut for the factory's
 *                        resetSessionState ordering
 *
 * Lifecycle:
 *   - `onResetSession` — pre-creates a new task board, aborts the
 *     previous bg controller, waits for the SIGTERM→SIGKILL window to
 *     drain, resets bash CWD, rotates the controller, swaps the board.
 *   - `onShutdown`     — aborts the bg controller and returns whether
 *     any live subprocesses were still running.
 *   - `hasActiveWork`  — `() => liveSubprocessCount > 0`.
 *
 * Approval handler for bash elicit:
 *   The stack reads `ctx.host[APPROVAL_HANDLER_HOST_KEY]` as its
 *   `ApprovalHandler`. The host bag is the canonical "cross-cutting
 *   callback" channel — the context interface stays narrow.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, ApprovalHandler, ManagedTaskBoard } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createOsAdapter, mergeProfile, restrictiveProfile } from "@koi/sandbox-os";
import { createTaskTools } from "@koi/task-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createBashBackgroundTool, createBashToolWithHooks } from "@koi/tools-bash";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

/** Key under `ctx.host` for the approval handler callback. */
export const APPROVAL_HANDLER_HOST_KEY = "approvalHandler";
/** Key under `ctx.host` for the synthetic agent id used by task tools. */
export const AGENT_ID_HOST_KEY = "agentId";

/** Maximum wait for SIGTERM→SIGKILL drain on resetSessionState (ms). */
const SUBPROCESS_DRAIN_MS = 3_500;

/** Well-known export keys. */
export const EXECUTION_EXPORTS = {
  bashHandle: "bashHandle",
  sandboxActive: "sandboxActive",
  getBgSignal: "getBgSignal",
  hasLiveProcesses: "hasLiveProcesses",
} as const;

export const executionStack: PresetStack = {
  id: "execution",
  description:
    "Bash with hooks/elicit + bash_background + ManagedTaskBoard + task_* tools + OS sandbox adapter",
  activate: async (ctx): Promise<StackContribution> => {
    const approvalHandler = ctx.host?.[APPROVAL_HANDLER_HOST_KEY] as ApprovalHandler | undefined;
    const agentId = ctx.host?.[AGENT_ID_HOST_KEY] as AgentId | undefined;

    // --- OS sandbox (optional — falls back to unsandboxed with denylist) ---
    const osSandboxResult = createOsAdapter();
    const sandboxAdapter = osSandboxResult.ok ? osSandboxResult.value : undefined;
    const sandboxProfile = osSandboxResult.ok
      ? mergeProfile(restrictiveProfile(), {
          network: { allow: true },
          filesystem: {
            allowWrite: [
              ctx.cwd, // workspace root
              "/tmp", // POSIX temp
              "/var/folders", // macOS user cache (Bun install, compiler cache)
            ],
          },
        })
      : undefined;

    // --- Bash AST-walker elicit fallback → caller's approval handler ---
    const bashElicit = async (params: {
      readonly command: string;
      readonly reason: string;
      readonly nodeType?: string;
    }): Promise<boolean> => {
      if (approvalHandler === undefined) {
        // No approval handler available: fail closed on the uncertain
        // branch. Matches the pre-stack behavior when the TUI had one
        // but `koi start`'s auto-allow bypass means this never hits.
        return false;
      }
      const reasonPrefix = params.nodeType !== undefined ? ` (${params.nodeType})` : "";
      const decision = await approvalHandler({
        toolId: "Bash",
        input: { command: params.command },
        reason: `AST walker cannot safely analyse this command${reasonPrefix}: ${params.reason}. Approval delegates to the regex TTP classifier for defense-in-depth.`,
      });
      return decision.kind === "allow" || decision.kind === "always-allow";
    };

    const bashHandle = createBashToolWithHooks({
      workspaceRoot: ctx.cwd,
      trackCwd: true,
      elicit: bashElicit,
      ...(sandboxAdapter !== undefined && sandboxProfile !== undefined
        ? { sandboxAdapter, sandboxProfile }
        : {}),
    });

    // --- Background task controller + live subprocess counter ---
    // let: mutable — rotated on session reset
    let bgController = new AbortController();
    // let: mutable — incremented/decremented from async completions
    let liveSubprocessCount = 0;

    // --- Task board behind Proxy over boardRef ---
    const boardRef: { current: ManagedTaskBoard } = {
      current: await createManagedTaskBoard({
        store: createMemoryTaskBoardStore(),
        resultsDir: join(tmpdir(), `koi-${ctx.hostId}-task-results`),
      }),
    };
    const taskBoard = new Proxy({} as ManagedTaskBoard, {
      get(_target, prop, receiver) {
        const value = Reflect.get(boardRef.current, prop, receiver);
        return typeof value === "function" ? value.bind(boardRef.current) : value;
      },
    });

    // --- bash_background provider ---
    const bashBackgroundProvider =
      agentId !== undefined
        ? createSingleToolProvider({
            name: "bash-background",
            toolName: "bash_background",
            createTool: () =>
              createBashBackgroundTool({
                taskBoard,
                getBoundBoard: () => boardRef.current,
                agentId,
                workspaceRoot: ctx.cwd,
                getSignal: () => bgController.signal,
                onSubprocessStart: () => {
                  liveSubprocessCount++;
                },
                onSubprocessEnd: () => {
                  liveSubprocessCount--;
                },
                elicit: bashElicit,
                ...(sandboxAdapter !== undefined && sandboxProfile !== undefined
                  ? { sandboxAdapter, sandboxProfile }
                  : {}),
              }),
          })
        : undefined;

    // --- task_* tools ---
    const taskToolProviders =
      agentId !== undefined
        ? createTaskTools({ board: taskBoard, agentId }).map((tool) =>
            createSingleToolProvider({
              name: `task-${tool.descriptor.name}`,
              toolName: tool.descriptor.name,
              createTool: () => tool,
            }),
          )
        : [];

    return {
      middleware: [],
      providers: [
        ...(bashBackgroundProvider !== undefined ? [bashBackgroundProvider] : []),
        ...taskToolProviders,
      ],
      exports: {
        [EXECUTION_EXPORTS.bashHandle]: bashHandle,
        [EXECUTION_EXPORTS.sandboxActive]: osSandboxResult.ok,
        [EXECUTION_EXPORTS.getBgSignal]: () => bgController.signal,
        [EXECUTION_EXPORTS.hasLiveProcesses]: () => liveSubprocessCount > 0,
      },
      hasActiveWork: () => liveSubprocessCount > 0,
      onShutdown: () => {
        const hadTasks = liveSubprocessCount > 0;
        bgController.abort();
        return hadTasks;
      },
      onResetSession: async () => {
        // 1. PRE-CREATE the new task board BEFORE anything else commits,
        //    matching the pre-stack ordering. If board creation fails
        //    (sqlite disk full, etc.) we want that surfaced before
        //    destructive state mutations below.
        const newBoard = await createManagedTaskBoard({
          store: createMemoryTaskBoardStore(),
          resultsDir: join(tmpdir(), `koi-${ctx.hostId}-task-results`),
        });

        // 2. Snapshot whether we have live processes so the drain wait
        //    fires only when actually needed.
        const hadLiveProcesses = liveSubprocessCount > 0;

        // 3. Abort the current controller — kills in-flight subprocesses.
        bgController.abort();
        if (hadLiveProcesses) {
          await new Promise<void>((resolve) => setTimeout(resolve, SUBPROCESS_DRAIN_MS));
        }

        // 4. Reset bash tracked CWD so the new session starts at workspace root.
        bashHandle.resetCwd();

        // 5. Rotate the controller so future launches use a fresh signal.
        bgController = new AbortController();

        // 6. Atomic board swap — the proxy auto-sees the new instance on
        //    next Reflect.get, so cached tool providers don't need rebuilding.
        boardRef.current = newBoard;
      },
    };
  },
};
