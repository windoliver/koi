import { type BashPolicy, classifyBashCommand, DEFAULT_BASH_POLICY } from "@koi/bash-security";
import type {
  JsonObject,
  SandboxAdapter,
  SandboxProfile,
  Tool,
  ToolExecuteOptions,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { execSandboxed, spawnBash } from "./exec.js";

/**
 * Sentinel appended to the command string when `trackCwd` is enabled.
 * After execution the last line matching `^__KOI_CWD__:` is parsed and stripped.
 * Uses `printf` — safe across shells, outputs the literal prefix + resolved cwd.
 *
 * The sentinel is the LAST line in the script so `set -e` prevents it from
 * printing when an earlier command fails — meaning cwd is only updated on success.
 */
const CWD_SENTINEL_PREFIX = "__KOI_CWD__:";
const CWD_SENTINEL_SUFFIX = `\nprintf '${CWD_SENTINEL_PREFIX}%s\\n' "$(pwd -P)"`;

/** Parse and strip the sentinel line from stdout. Returns null if not found. */
function extractCwdSentinel(stdout: string): { cwd: string; stdout: string } | null {
  const lines = stdout.split("\n");
  // Search backwards — sentinel is the last meaningful line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.startsWith(CWD_SENTINEL_PREFIX)) {
      const cwd = line.slice(CWD_SENTINEL_PREFIX.length).trim();
      if (cwd.length === 0) return null;
      const strippedLines = [...lines.slice(0, i), ...lines.slice(i + 1)];
      // Remove trailing empty line left by stripping the sentinel
      while (strippedLines.length > 0 && strippedLines[strippedLines.length - 1] === "") {
        strippedLines.pop();
      }
      return { cwd, stdout: strippedLines.length > 0 ? `${strippedLines.join("\n")}\n` : "" };
    }
  }
  return null;
}

export interface BashToolConfig {
  /**
   * Workspace root directory. Relative `cwd` arguments are resolved
   * against this path and must remain within it.
   *
   * Defaults to `process.cwd()`.
   */
  readonly workspaceRoot?: string;
  /** Security policy applied to every command. */
  readonly policy?: BashPolicy;
  /**
   * OS sandbox adapter — when provided, all bash execution is routed through
   * the sandbox adapter instead of spawned directly.
   *
   * Inject at L3 (CLI/runtime) to transparently confine every Bash invocation
   * without exposing a separate tool to the model.
   */
  readonly sandboxAdapter?: SandboxAdapter;
  /**
   * Sandbox profile applied when `sandboxAdapter` is provided.
   *
   * Defaults to a restrictive profile (no network, credential paths denied,
   * defaultReadAccess open). Must be provided alongside `sandboxAdapter`.
   */
  readonly sandboxProfile?: SandboxProfile;
  /**
   * When true, the tool tracks the working directory across calls.
   * After each successful execution, reads `pwd -P` from the subprocess
   * output and stores it for the next call.
   *
   * Enables `cd` commands to persist between tool invocations.
   * The tracked cwd is used as the default when `args.cwd` is not provided.
   * An explicit `args.cwd` always overrides the tracked cwd for that call,
   * but the tracked cwd still updates from the executed command.
   *
   * Defaults to false — opt-in to avoid unexpected state mutation.
   */
  readonly trackCwd?: boolean;
}

/** Shape of the bash tool's JSON output on success. */
interface BashSuccessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut?: true;
  readonly truncated?: true;
  readonly truncatedNote?: string;
  /** True when the command ran inside an OS sandbox (seatbelt/bwrap). */
  readonly sandboxed?: boolean;
}

/** Shape of the bash tool's JSON output when the command is blocked. */
interface BashBlockedResult {
  readonly error: string;
  readonly category: string;
  readonly reason: string;
  readonly pattern: string;
}

type BashResult = BashSuccessResult | BashBlockedResult;

/**
 * Create a bash execution tool that guards every command through the
 * @koi/bash-security classifier pipeline before spawning.
 *
 * Security model (what IS enforced):
 * - classifyBashCommand() pipeline: allowlist → injection → path → command
 * - Spawn uses `bash --noprofile --norc` to prevent profile-based escalation
 * - `set -euo pipefail` is prepended to every command string
 * - Environment is replaced with a minimal safe set (no inherited env vars)
 * - Working directory (`cwd`) is validated against `workspaceRoot`
 * - AbortSignal wired to SIGTERM → SIGKILL (process group, all descendants)
 * - Output is capped at BashPolicy.maxOutputBytes (default 1 MB)
 *
 * Known limitation (what is NOT enforced):
 * - File path arguments *inside* the command string are NOT validated.
 *   A command like `cat /etc/passwd` passes even if cwd is within the workspace.
 *   This tool relies on the denylist (reverse shells, escalation, etc.) and the
 *   allowlist (if configured) for command-level control.  For full filesystem
 *   confinement inject an OS sandbox via `sandboxAdapter` at the L3 integration layer.
 */
/**
 * Bash tool + session reset hook.
 *
 * Use when `trackCwd: true` and the caller needs to reset tracked state on
 * session clear (e.g. `agent:clear` / `session:new` in the TUI). Calling
 * `resetCwd()` restores the working directory to `workspaceRoot` so a new
 * conversation starts from a known directory.
 *
 * Backward-compatible: `createBashTool` continues to return just the Tool.
 */
export interface BashToolHandle {
  readonly tool: Tool;
  /** Reset tracked cwd back to workspaceRoot. No-op when trackCwd is false. */
  readonly resetCwd: () => void;
}

export function createBashTool(config?: BashToolConfig): Tool {
  return createBashToolWithHooks(config).tool;
}

export function createBashToolWithHooks(config?: BashToolConfig): BashToolHandle {
  // workspaceRoot gates cwd containment.  When omitted the cwd is still
  // validated against process.cwd() so the tool is never fully unconstrained.
  const workspaceRoot = config?.workspaceRoot ?? process.cwd();
  const policy: BashPolicy = {
    ...DEFAULT_BASH_POLICY,
    ...config?.policy,
  };
  const maxOutputBytes = policy.maxOutputBytes ?? DEFAULT_BASH_POLICY.maxOutputBytes ?? 1_048_576;
  const defaultTimeoutMs =
    policy.defaultTimeoutMs ?? DEFAULT_BASH_POLICY.defaultTimeoutMs ?? 30_000;
  const sandboxAdapter = config?.sandboxAdapter;
  const sandboxProfile = config?.sandboxProfile;
  const trackCwd = config?.trackCwd ?? false;

  // let justified: mutable cwd state for trackCwd — updated after each successful execution.
  // Reset to workspaceRoot on session clear via resetCwd().
  let currentCwd = workspaceRoot;

  const tool: Tool = {
    descriptor: {
      name: "Bash",
      description:
        "Execute a bash command. The working directory is validated against the workspace root. " +
        "Known-dangerous patterns (reverse shells, privilege escalation, injection vectors) are " +
        "blocked by classifier. File path arguments inside the command string are NOT further " +
        "restricted — for full filesystem confinement use an OS sandbox via sandboxAdapter.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command. Must be within the workspace root. " +
              "Defaults to workspace root. Note: file path arguments inside the command " +
              "string are not additionally validated — use absolute paths under the workspace.",
          },
          timeoutMs: {
            type: "number",
            description: `Execution timeout in milliseconds. Defaults to ${defaultTimeoutMs}ms.`,
          },
        },
        required: ["command"],
      } as JsonObject,
      tags: ["shell", "execution"],
    },
    origin: "primordial",
    // When sandboxAdapter is injected (L3 concern), the tool runs inside an OS
    // sandbox (seatbelt/bwrap) — policy reflects the actual execution environment.
    policy: sandboxAdapter !== undefined ? DEFAULT_SANDBOXED_POLICY : DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<BashResult> => {
      const signal = options?.signal;
      signal?.throwIfAborted();

      const command = args.command;
      if (typeof command !== "string" || command.trim() === "") {
        return {
          error: "command must be a non-empty string",
          category: "injection",
          reason: "Empty or invalid command argument",
          pattern: "",
        };
      }

      // When trackCwd is enabled: use the tracked cwd as default (falls back to
      // workspaceRoot on first call). An explicit args.cwd overrides for this call
      // only — cwd tracking only updates when no explicit cwd was provided.
      const explicitCwd = typeof args.cwd === "string" ? args.cwd : undefined;
      const rawCwd = explicitCwd ?? (trackCwd ? currentCwd : workspaceRoot);
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : defaultTimeoutMs;

      // Security classification pipeline (allowlist → injection → path → command)
      const classifyOpts = {
        cwd: rawCwd,
        policy,
        workspaceRoot,
      };
      const classification = classifyBashCommand(command, classifyOpts);
      if (!classification.ok) {
        return {
          error: "Command blocked by security policy",
          category: classification.category,
          reason: classification.reason,
          pattern: classification.pattern,
        };
      }

      // Assemble the full command string:
      //   set -euo pipefail (fail-fast defaults)
      //   ${command}
      //   [sentinel to capture cwd — only when trackCwd AND no explicit cwd override]
      //   An explicit cwd override is a one-off: don't update the tracked cwd from it.
      const updateTrackedCwd = trackCwd && explicitCwd === undefined;
      const fullCommand = updateTrackedCwd
        ? `set -euo pipefail\n${command}${CWD_SENTINEL_SUFFIX}`
        : `set -euo pipefail\n${command}`;

      // Route through OS sandbox when adapter is injected (L3 DI pattern).
      const raw =
        sandboxAdapter !== undefined && sandboxProfile !== undefined
          ? await execSandboxed(
              sandboxAdapter,
              sandboxProfile,
              fullCommand,
              rawCwd,
              timeoutMs,
              maxOutputBytes,
              signal,
            )
          : await spawnBash(fullCommand, rawCwd, timeoutMs, maxOutputBytes, signal);

      // Parse and strip cwd sentinel when tracking is active for this call.
      // Only update on exitCode === 0 to avoid updating on partial failures.
      let stdout = raw.stdout;
      if (updateTrackedCwd && raw.exitCode === 0) {
        const parsed = extractCwdSentinel(stdout);
        if (parsed !== null) {
          currentCwd = parsed.cwd;
          stdout = parsed.stdout;
        }
      }

      return {
        stdout,
        stderr: raw.stderr,
        exitCode: raw.exitCode,
        durationMs: raw.durationMs,
        ...(sandboxAdapter !== undefined ? { sandboxed: true } : {}),
        ...(raw.timedOut ? { timedOut: true as const } : {}),
        ...(raw.truncated
          ? {
              truncated: true as const,
              truncatedNote: raw.truncatedNote,
            }
          : {}),
      };
    },
  };

  return {
    tool,
    resetCwd: () => {
      currentCwd = workspaceRoot;
    },
  };
}
