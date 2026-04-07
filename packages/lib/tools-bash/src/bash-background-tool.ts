import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { Readable } from "node:stream";
import { type BashPolicy, classifyBashCommand, DEFAULT_BASH_POLICY } from "@koi/bash-security";
import type {
  AgentId,
  JsonObject,
  ManagedTaskBoard,
  TaskItemId,
  Tool,
  ToolExecuteOptions,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { SpawnTransform, SpawnTransformInput } from "./bash-tool.js";

/** Grace period before escalating SIGTERM to SIGKILL on cancellation. */
const SIGKILL_ESCALATION_MS = 3_000;

/** Default timeout for background tasks (5 minutes). */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 300_000;

/** Safe minimal environment for spawned bash processes. */
const SAFE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "dumb",
} as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BashBackgroundToolConfig {
  readonly workspaceRoot?: string;
  readonly policy?: BashPolicy;
  /** Task board for registering background tasks. L0 interface, wired at L3. */
  readonly board: ManagedTaskBoard;
  /** Agent ID for task ownership. */
  readonly agentId: AgentId;
  /** Optional spawn transform for OS-level sandboxing. */
  readonly wrapCommand?: SpawnTransform;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/** Bundle returned by createBashBackgroundTool — tool + lifecycle methods. */
export interface BashBackgroundToolBundle {
  readonly tool: Tool;
  /** Cancel a running background task by ID. */
  readonly cancel: (taskId: string) => void;
  /** Kill all active background processes (call on shutdown). */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ActiveProcess {
  readonly proc: ChildProcess;
  readonly abortController: AbortController;
  /** SIGKILL escalation timer — must be cleared when process exits to avoid killing reused PIDs. */
  killTimer?: ReturnType<typeof setTimeout>;
  /** Set when the process is aborted (cancel/timeout). Used to route to fail instead of complete. */
  aborted?: boolean;
  /** Reason for abort — surfaced in the failure message. */
  abortReason?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a background bash execution tool that spawns detached subprocesses
 * and returns immediately with a task ID. Output is drained continuously
 * to prevent pipe deadlock, and the result is written to the task board
 * on completion.
 *
 * The LLM polls progress via existing `task_get` / `task_output` tools.
 */
export function createBashBackgroundTool(
  config: BashBackgroundToolConfig,
): BashBackgroundToolBundle {
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  const policy: BashPolicy = { ...DEFAULT_BASH_POLICY, ...config.policy };
  const maxOutputBytes = policy.maxOutputBytes ?? DEFAULT_BASH_POLICY.maxOutputBytes ?? 1_048_576;
  const defaultTimeoutMs = DEFAULT_BACKGROUND_TIMEOUT_MS;

  const active = new Map<string, ActiveProcess>();

  const tool: Tool = {
    descriptor: {
      name: "BashBackground",
      description:
        "Execute a long-running bash command in the background. Returns a task ID immediately. " +
        "Use task_get / task_output to poll for progress and results. " +
        "Known-dangerous patterns are blocked by classifier.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute in the background",
          },
          description: {
            type: "string",
            description: "Human-readable description of the background task",
          },
          cwd: {
            type: "string",
            description: "Working directory. Must be within workspace root.",
          },
          timeoutMs: {
            type: "number",
            description: `Timeout in milliseconds. Defaults to ${defaultTimeoutMs}ms (5 minutes).`,
          },
        },
        required: ["command"],
      } as JsonObject,
      tags: ["shell", "execution", "background"],
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,

    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      options?.signal?.throwIfAborted();

      const command = args.command;
      if (typeof command !== "string" || command.trim() === "") {
        return { error: "command must be a non-empty string" };
      }

      const cwd = typeof args.cwd === "string" ? args.cwd : workspaceRoot;
      const description =
        typeof args.description === "string"
          ? args.description
          : `Background: ${command.slice(0, 80)}`;
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;

      // Security classification
      const classification = classifyBashCommand(command, { cwd, policy, workspaceRoot });
      if (!classification.ok) {
        return {
          error: "Command blocked by security policy",
          category: classification.category,
          reason: classification.reason,
          pattern: classification.pattern,
        };
      }

      // Reject non-durable boards — background task output must survive restart.
      // Same guard as task-update tools to prevent silent result loss.
      if (!config.board.hasResultPersistence()) {
        return {
          error:
            "Background tasks require a board with result persistence. " +
            "Configure a resultsDir on the ManagedTaskBoard.",
        };
      }

      // Register task on the board
      const taskId = await config.board.nextId();
      const addResult = await config.board.add({
        id: taskId,
        subject: description,
        description: `bash-background: ${command}`,
        activeForm: description,
      });
      if (!addResult.ok) {
        return { error: `Failed to register task: ${addResult.error.message}` };
      }

      // Assign to agent — fail the task if assignment fails to avoid orphan
      const assignResult = await config.board.assign(taskId, config.agentId);
      if (!assignResult.ok) {
        await config.board.fail(taskId, {
          code: "EXTERNAL",
          message: `Failed to assign: ${assignResult.error.message}`,
          retryable: false,
        });
        return { error: `Failed to assign task: ${assignResult.error.message}` };
      }

      // Spawn subprocess — wrapped in try/catch to fail the task on
      // synchronous spawn errors (bad cwd, invalid argv from wrapCommand, etc.)
      let proc: ReturnType<typeof spawnChild>;
      const abortController = new AbortController();
      try {
        const baseInput: SpawnTransformInput = {
          argv: ["bash", "--noprofile", "--norc", "-c", `set -euo pipefail\n${command}`],
          cwd,
          env: SAFE_ENV,
        };
        const spawnOpts =
          config.wrapCommand !== undefined ? config.wrapCommand(baseInput) : baseInput;
        const [cmd, ...cmdArgs] = spawnOpts.argv;
        if (cmd === undefined) {
          await config.board.fail(taskId, {
            code: "VALIDATION",
            message: "SpawnTransform returned empty argv",
            retryable: false,
          });
          return { error: "SpawnTransform returned empty argv" };
        }

        proc = spawnChild(cmd, cmdArgs, {
          cwd: spawnOpts.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: spawnOpts.env,
          detached: true,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await config.board.fail(taskId, {
          code: "EXTERNAL",
          message: `Spawn failed: ${message}`,
          retryable: false,
        });
        return { error: `Failed to spawn: ${message}` };
      }

      const entry: ActiveProcess = { proc, abortController };
      active.set(String(taskId), entry);

      // Wire timeout — marks the entry as aborted with reason
      const timer = setTimeout(() => {
        entry.aborted = true;
        entry.abortReason = "timeout";
        abortController.abort();
      }, timeoutMs);

      // Wire abort signal to process kill — stores SIGKILL escalation timer
      // on the active entry so drainAndComplete can clear it after exit.
      const onAbort = (): void => {
        const pid = proc.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* already exited */
          }
        }
        entry.killTimer = setTimeout(() => {
          try {
            if (pid !== undefined) process.kill(-pid, "SIGKILL");
          } catch {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* already exited */
            }
          }
        }, SIGKILL_ESCALATION_MS);
      };
      abortController.signal.addEventListener("abort", onAbort, { once: true });

      // Fire-and-forget drain chain — runs in background, updates board on completion
      void drainAndComplete(
        proc,
        taskId,
        config.board,
        config.agentId,
        maxOutputBytes,
        timer,
        active,
      );

      return {
        taskId: String(taskId),
        message: `Background task started: ${description}`,
      };
    },
  };

  function cancel(taskId: string): void {
    const entry = active.get(taskId);
    if (entry !== undefined) {
      entry.aborted = true;
      entry.abortReason = "cancelled";
      entry.abortController.abort();
      // Don't delete from active — drainAndComplete will do it after cleanup
    }
  }

  /**
   * Kill all active background processes and fail their tasks on the board.
   * Must be called during shutdown to prevent orphaned subprocesses and
   * stale in_progress tasks.
   *
   * **Limitation**: If the host process crashes without calling dispose(),
   * detached subprocesses will continue running with no owner. Full
   * cross-restart recovery (PID persistence, reattach) is out of scope
   * for this tool — use process-level supervision (systemd, launchd) for
   * crash resilience.
   */
  function dispose(): void {
    for (const [taskId, entry] of active) {
      entry.aborted = true;
      entry.abortReason = "disposed";
      entry.abortController.abort();
      // Best-effort: immediately fail the task so it doesn't stay in_progress
      // if drainAndComplete doesn't run before process exit.
      void config.board.fail(taskId as TaskItemId, {
        code: "EXTERNAL",
        message: "Background task killed during shutdown (dispose)",
        retryable: false,
      });
    }
  }

  return { tool, cancel, dispose };
}

// ---------------------------------------------------------------------------
// Background drain + completion
// ---------------------------------------------------------------------------

async function drainAndComplete(
  proc: ChildProcess,
  taskId: TaskItemId,
  board: ManagedTaskBoard,
  agentId: AgentId,
  maxOutputBytes: number,
  timer: ReturnType<typeof setTimeout>,
  active: Map<string, ActiveProcess>,
): Promise<void> {
  try {
    const stdoutStream: ReadableStream<Uint8Array> | null =
      proc.stdout !== null ? (Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>) : null;
    const stderrStream: ReadableStream<Uint8Array> | null =
      proc.stderr !== null ? (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>) : null;

    const budget = { remaining: maxOutputBytes };
    let spawnError: Error | undefined;
    const exited = new Promise<number>((resolve) => {
      proc.on("exit", (code) => resolve(code ?? 1));
      proc.on("error", (err: Error) => {
        spawnError = err;
        resolve(1);
      });
    });

    const [stdoutResult, stderrResult] = await Promise.all([
      drainStream(stdoutStream, budget),
      drainStream(stderrStream, budget),
    ]);
    const exitCode = await exited;

    clearTimeout(timer);
    // Clear SIGKILL escalation timer to prevent killing a reused PID/process group
    const entry = active.get(String(taskId));
    if (entry?.killTimer !== undefined) clearTimeout(entry.killTimer);
    const wasAborted = entry?.aborted === true;
    const abortReason = entry?.abortReason ?? "unknown";
    active.delete(String(taskId));

    // Assemble output early so it's available for all paths (success, failure, abort).
    // Operators need stdout/stderr for debugging failed background tasks.
    const output = [
      stdoutResult.text.length > 0 ? `stdout:\n${stdoutResult.text}` : "",
      stderrResult.text.length > 0 ? `stderr:\n${stderrResult.text}` : "",
      `exit code: ${exitCode}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (spawnError !== undefined) {
      await failTask(board, taskId, agentId, `Spawn failed: ${spawnError.message}\n\n${output}`);
      return;
    }

    // Aborted tasks (cancel, timeout, dispose) are routed to fail — not complete.
    // This prevents partial execution from being surfaced as successful work.
    if (wasAborted) {
      await failTask(
        board,
        taskId,
        agentId,
        `Background task aborted (${abortReason}), exit code: ${exitCode}\n\n${output}`,
      );
      return;
    }

    // Non-zero exit = failed task. Reserve `completed` for exit 0 only.
    if (exitCode !== 0) {
      await failTask(
        board,
        taskId,
        agentId,
        `Background command failed with exit code ${exitCode}\n\n${output}`,
      );
      return;
    }

    const completeResult = await board.completeOwnedTask(taskId, agentId, {
      taskId,
      output,
      durationMs: 0, // not tracked for background tasks
      results: {
        exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        truncated: stdoutResult.truncated || stderrResult.truncated,
      },
    });
    // If completion failed (ownership conflict, persistence error), mark failed
    // so the task doesn't stay stuck in_progress.
    if (!completeResult.ok) {
      await board.fail(taskId, {
        code: "EXTERNAL",
        message: `Background task ran but completeOwnedTask rejected: ${completeResult.error.message}`,
        retryable: false,
      });
    }
  } catch {
    // Best-effort — if board update fails, the task stays in_progress
    // and can be cleaned up by the coordinator.
    active.delete(String(taskId));
  }
}

/**
 * Mark a task as failed via owned path, falling back to unowned path on conflict.
 * Consolidates the repeated fail + fallback pattern.
 */
async function failTask(
  board: ManagedTaskBoard,
  taskId: TaskItemId,
  agentId: AgentId,
  message: string,
): Promise<void> {
  const result = await board.failOwnedTask(taskId, agentId, {
    code: "EXTERNAL",
    message,
    retryable: false,
  });
  if (!result.ok) {
    await board.fail(taskId, {
      code: "EXTERNAL",
      message: `${message} (failOwnedTask rejected: ${result.error.message})`,
      retryable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Stream drain (duplicated from bash-tool.ts to avoid circular exports)
// ---------------------------------------------------------------------------

interface DrainResult {
  readonly text: string;
  readonly truncated: boolean;
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  budget: { remaining: number },
): Promise<DrainResult> {
  if (stream == null) return { text: "", truncated: false };

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (budget.remaining <= 0) {
        truncated = true;
        continue;
      }
      const chunk = value.length <= budget.remaining ? value : value.slice(0, budget.remaining);
      text += decoder.decode(chunk, { stream: true });
      budget.remaining -= chunk.length;
      if (value.length > chunk.length) {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}
