/**
 * bash_background tool — fire-and-forget bash execution backed by @koi/tasks.
 *
 * Spawns a subprocess immediately and returns a TaskItemId. The agent can
 * poll progress via the existing task_get / task_output tools without blocking
 * the agent loop.
 *
 * Layer note: ManagedTaskBoard is defined in @koi/core (L0), so @koi/tools-bash
 * (L2) can accept it as a config dependency without a peer L2→L2 import.
 * The concrete implementation (@koi/tasks) is injected at L3 (tui-runtime).
 */

import {
  classifyBashCommand,
  classifyBashCommandWithElicit,
  type ElicitCallback,
  initializeBashAst,
} from "@koi/bash-ast";
import { type BashPolicy, DEFAULT_BASH_POLICY } from "@koi/bash-security";
import type {
  AgentId,
  JsonObject,
  ManagedTaskBoard,
  SandboxAdapter,
  SandboxProfile,
  Tool,
  ToolExecuteOptions,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY, taskItemId } from "@koi/core";
import { execSandboxed, spawnBash } from "./exec.js";

/** Default timeout for background tasks — 30 minutes (long-running builds, installs). */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60 * 1_000;

/** Max output bytes for background tasks — same 1 MB cap as foreground Bash. */
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export interface BashBackgroundToolConfig {
  /**
   * Task board for tracking background job lifecycle.
   * Injected at L3 — accepts ManagedTaskBoard from @koi/core (L0 interface).
   *
   * On session reset the board may be rotated to a fresh instance. To prevent
   * a prior-session task completion from writing to the new session's board,
   * provide `getBoundBoard` alongside `taskBoard`: the tool captures the concrete
   * board at task-launch time and routes all task lifecycle calls through it.
   */
  readonly taskBoard: ManagedTaskBoard;
  /**
   * Optional factory called at task-launch time to capture the concrete board
   * instance (not a proxy). If provided, `runBackground()` uses this board for
   * all completion/failure writes, preventing cross-session board contamination
   * after a board rotation triggered by `resetSessionState()`.
   *
   * Pass `() => boardRef.current` from the runtime to bind each task to the
   * board that was active when the task was launched.
   */
  readonly getBoundBoard?: (() => ManagedTaskBoard) | undefined;
  /**
   * Agent ID used to assign and complete tasks on the board.
   * Background tasks are assigned to this agent so task_output authorization passes.
   */
  readonly agentId: AgentId;
  /** Workspace root for cwd validation. Defaults to `process.cwd()`. */
  readonly workspaceRoot?: string | undefined;
  /** Security policy applied to every command. Defaults to DEFAULT_BASH_POLICY. */
  readonly policy?: BashPolicy | undefined;
  /** OS sandbox adapter — when provided, routes execution through seatbelt/bwrap. */
  readonly sandboxAdapter?: SandboxAdapter | undefined;
  /** Sandbox profile — required alongside `sandboxAdapter`. */
  readonly sandboxProfile?: SandboxProfile | undefined;
  /**
   * Return the current abort signal for the active session.
   *
   * Called at each background task launch (not at tool construction). Use a
   * function — rather than a static signal — so the runtime can rotate the
   * controller on session reset: the old signal is aborted (killing prior-session
   * subprocesses) and the function starts returning the new controller's signal.
   *
   * When the runtime disposes, abort the controller before calling runtime.dispose()
   * via `shutdownBackgroundTasks()` on TuiRuntimeHandle.
   *
   * Note: `task_stop` only updates task-board state; it cannot terminate the OS
   * subprocess without a per-task cancellation channel — tracked as a follow-up.
   */
  readonly getSignal?: (() => AbortSignal | undefined) | undefined;
  /**
   * Called just before spawning a background subprocess.
   *
   * Use to maintain an authoritative live-subprocess count for shutdown
   * coordination — task-board status is not a reliable proxy (task_stop changes
   * board state without terminating the OS process).
   */
  readonly onSubprocessStart?: (() => void) | undefined;
  /**
   * Called when a background subprocess exits (success, failure, or abort).
   *
   * Paired with `onSubprocessStart`. Guaranteed to fire exactly once per start.
   */
  readonly onSubprocessEnd?: (() => void) | undefined;
  /**
   * Optional interactive elicit callback for too-complex commands — see
   * `BashToolConfig.elicit`. Same semantics: when provided, replaces the
   * transitional regex fallback with an interactive user prompt.
   *
   * Closes #1634.
   */
  readonly elicit?: ElicitCallback | undefined;
}

/** Shape of the tool's JSON response on successful task creation. */
interface BashBackgroundStarted {
  readonly taskId: string;
  readonly status: "in_progress";
  readonly message: string;
}

/** Shape of the tool's JSON response when the command is blocked. */
interface BashBackgroundBlocked {
  readonly error: string;
  readonly category: string;
  readonly reason: string;
  readonly pattern: string;
}

type BashBackgroundResult = BashBackgroundStarted | BashBackgroundBlocked;

/**
 * Create the bash_background tool.
 *
 * Returns immediately with a task ID. The agent polls with task_get(taskId) to
 * check status and task_output(taskId) once completed to read stdout/stderr.
 *
 * Best suited for long-running commands: npm/bun/yarn install, docker compose up,
 * cargo build, go build, make, pytest, etc. For quick commands (< 30s) prefer Bash.
 */
export function createBashBackgroundTool(config: BashBackgroundToolConfig): Tool {
  const {
    taskBoard,
    getBoundBoard,
    agentId,
    sandboxAdapter,
    sandboxProfile,
    getSignal,
    onSubprocessStart,
    onSubprocessEnd,
    elicit,
  } = config;
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  const policy: BashPolicy = { ...DEFAULT_BASH_POLICY, ...config.policy };

  return {
    descriptor: {
      name: "bash_background",
      description:
        "Run a bash command in the background and return a task ID immediately. " +
        "The command runs asynchronously — use task_get(taskId) to check status, " +
        "task_output(taskId) to read stdout/stderr once completed. " +
        "task_stop(taskId) updates task-board status but does NOT terminate the OS process. " +
        "Best for long-running build or test commands (cargo build, go build, make, pytest, " +
        "bun test, etc.). For network-requiring commands (npm/bun install, docker compose up) " +
        "check that the runtime sandbox allows network access. For quick commands (< 30s) prefer Bash.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to run in the background",
          },
          cwd: {
            type: "string",
            description: "Working directory. Defaults to workspace root.",
          },
          description: {
            type: "string",
            description:
              "Human-readable description shown in task lists (e.g. 'Installing dependencies'). " +
              "Defaults to the command string.",
          },
        },
        required: ["command"],
      } as JsonObject,
      tags: ["shell", "background", "async"],
    },
    origin: "primordial",
    policy: sandboxAdapter !== undefined ? DEFAULT_SANDBOXED_POLICY : DEFAULT_UNSANDBOXED_POLICY,
    execute: async (
      args: JsonObject,
      options?: ToolExecuteOptions,
    ): Promise<BashBackgroundResult> => {
      // Reject immediately if the enclosing turn was already aborted (e.g. Ctrl+C).
      // Without this check, the tool would still allocate a task and spawn a subprocess
      // after the user interrupted the request, causing a rollback/idempotency gap.
      if (options?.signal?.aborted) {
        return {
          error: "Command cancelled before launch",
          category: "injection",
          reason: "Tool call was aborted before subprocess launch",
          pattern: "",
        };
      }

      // Ensure the bash AST parser is initialised before the sync classifier
      // reads the cached parser (idempotent off the cached init promise).
      await initializeBashAst();

      const command = args.command;
      if (typeof command !== "string" || command.trim() === "") {
        return {
          error: "command must be a non-empty string",
          category: "injection",
          reason: "Empty or invalid command argument",
          pattern: "",
        };
      }

      const cwd = typeof args.cwd === "string" ? args.cwd : workspaceRoot;
      const description =
        typeof args.description === "string" && args.description.trim().length > 0
          ? args.description
          : command;

      // Security classification — same pipeline as foreground Bash. When
      // `elicit` is wired (L3 runtime), `too-complex` commands with non-
      // hard-deny nodeTypes are routed to an interactive user prompt
      // instead of silently passing through the regex fallback. See
      // `classifyBashCommandWithElicit` for the full contract.
      const classifyOpts = { cwd, policy, workspaceRoot };
      const signal = options?.signal;
      const classification =
        elicit !== undefined
          ? await classifyBashCommandWithElicit(command, {
              ...classifyOpts,
              elicit,
              ...(signal !== undefined ? { signal } : {}),
            })
          : classifyBashCommand(command, classifyOpts);
      if (!classification.ok) {
        return {
          error: "Command blocked by security policy",
          category: classification.category,
          reason: classification.reason,
          pattern: classification.pattern,
        };
      }

      // Register task on the board: pending → in_progress
      const id = taskItemId(await taskBoard.nextId());
      const addResult = await taskBoard.add({
        id,
        subject: description.length > 80 ? `${description.slice(0, 77)}…` : description,
        description,
        activeForm: `Running: ${command.length > 60 ? `${command.slice(0, 57)}…` : command}`,
      });
      if (!addResult.ok) {
        return {
          error: `Failed to create task: ${addResult.error.message}`,
          category: "injection",
          reason: addResult.error.message,
          pattern: "",
        };
      }

      // Assign to this agent (pending → in_progress)
      const assignResult = await taskBoard.assign(id, agentId);
      if (!assignResult.ok) {
        return {
          error: `Failed to start task: ${assignResult.error.message}`,
          category: "injection",
          reason: assignResult.error.message,
          pattern: "",
        };
      }

      // Combine the turn's abort signal with the session's shutdown signal so
      // the subprocess is terminated if either the enclosing turn is interrupted
      // (Ctrl+C / agent:clear) or the runtime shuts down (SIGINT/SIGTERM).
      const turnSignal = options?.signal;
      const sessionSignal = getSignal?.();
      const combinedSignal: AbortSignal | undefined =
        turnSignal !== undefined && sessionSignal !== undefined
          ? AbortSignal.any([turnSignal, sessionSignal])
          : (turnSignal ?? sessionSignal);

      // Capture the concrete board at task-launch time to prevent cross-session
      // contamination: if the proxy's underlying board is rotated after this task
      // launches (session reset), runBackground() still writes to the board that
      // owns this task id rather than the new session's board.
      const boundBoard = getBoundBoard?.() ?? taskBoard;

      // Fire-and-forget: spawn subprocess, update task board on completion.
      // No await — returns the task ID to the agent immediately.
      // onSubprocessStart/End provide an authoritative live-process count for
      // shutdown coordination, independent of task-board state.
      onSubprocessStart?.();
      void runBackground(
        command,
        cwd,
        id,
        agentId,
        boundBoard,
        sandboxAdapter,
        sandboxProfile,
        combinedSignal,
      ).finally(() => onSubprocessEnd?.());

      return {
        taskId: id,
        status: "in_progress",
        message:
          `Background task started (id: ${id}). ` +
          `Poll with task_get("${id}") to check status, ` +
          `task_output("${id}") to read output once completed.`,
      };
    },
  };
}

/**
 * Run the command and update the task board when it exits.
 * Called fire-and-forget — not awaited by the tool execute handler.
 *
 * `shutdownSignal` is aborted when the runtime disposes, ensuring the subprocess
 * is terminated via SIGTERM → SIGKILL before the process exits. Without this,
 * background commands can outlive the session and mutate the workspace silently.
 *
 * Note: `task_stop` only updates task-board state. To actually kill the OS process,
 * a shared cancellation channel from @koi/core is required — tracked as a follow-up.
 */
async function runBackground(
  command: string,
  cwd: string,
  id: ReturnType<typeof taskItemId>,
  agentId: AgentId,
  taskBoard: ManagedTaskBoard,
  sandboxAdapter: SandboxAdapter | undefined,
  sandboxProfile: SandboxProfile | undefined,
  shutdownSignal: AbortSignal | undefined,
): Promise<void> {
  const fullCommand = `set -euo pipefail\n${command}`;
  try {
    const result =
      sandboxAdapter !== undefined && sandboxProfile !== undefined
        ? await execSandboxed(
            sandboxAdapter,
            sandboxProfile,
            fullCommand,
            cwd,
            DEFAULT_BACKGROUND_TIMEOUT_MS,
            DEFAULT_MAX_OUTPUT_BYTES,
            shutdownSignal,
          )
        : await spawnBash(
            fullCommand,
            cwd,
            DEFAULT_BACKGROUND_TIMEOUT_MS,
            DEFAULT_MAX_OUTPUT_BYTES,
            shutdownSignal,
          );

    // Build output string: stdout, then stderr if non-empty
    const outputParts: string[] = [];
    if (result.stdout.length > 0) outputParts.push(result.stdout);
    if (result.stderr.length > 0) outputParts.push(`--- stderr ---\n${result.stderr}`);
    const output = outputParts.join("\n") || "(no output)";

    if (result.exitCode === 0 && !result.timedOut) {
      const r = await taskBoard.completeOwnedTask(id, agentId, {
        taskId: id,
        output,
        durationMs: result.durationMs,
        results: {
          exitCode: result.exitCode,
          ...(result.truncated ? { truncated: true, truncatedNote: result.truncatedNote } : {}),
        },
      });
      // If the board rejects completion (e.g. task was already stopped mid-flight),
      // best-effort fail so the board reflects a terminal state with preserved output.
      if (!r.ok) {
        await taskBoard
          .failOwnedTask(id, agentId, {
            code: "EXTERNAL",
            message: `Board rejected completion: ${r.error.message}; output preserved: ${output.slice(0, 200)}`,
            retryable: false,
          })
          .catch(() => {
            /* already in terminal state — ignore */
          });
      }
    } else {
      const reason = result.timedOut
        ? `Command timed out after ${DEFAULT_BACKGROUND_TIMEOUT_MS}ms`
        : `Command exited with code ${result.exitCode}`;
      const r = await taskBoard.failOwnedTask(id, agentId, {
        code: "EXTERNAL",
        message: reason,
        retryable: false,
        context: { exitCode: result.exitCode, timedOut: result.timedOut, output },
      });
      if (!r.ok) {
        // Task was already stopped/cancelled — the failure is expected; nothing to do.
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort fail — if the board call also throws, swallow to prevent unhandled rejection
    await taskBoard
      .failOwnedTask(id, agentId, {
        code: "EXTERNAL",
        message: `Background execution error: ${message}`,
        retryable: false,
      })
      .catch(() => {
        /* already in terminal state */
      });
  }
}
