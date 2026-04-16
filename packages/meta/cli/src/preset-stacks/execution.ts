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

import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
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
/**
 * Key under `ctx.host` for the task-board tool surface opt-in.
 *
 * When `true`, the execution stack wires the full `task_*` tool set
 * (`task_create`, `task_list`, `task_get`, `task_update`, `task_stop`,
 * `task_output`, `task_delegate`). When `false`, NO task tools are
 * registered.
 *
 * The factory sets this to `true` whenever the spawn preset stack is
 * active for the current host and `false` otherwise. Rationale: the
 * task board is coordinator infrastructure — sub-agent fan-out uses
 * `task_create` + `task_delegate`, and polling for results uses
 * `task_output`. Without the spawn stack there is no reason to call
 * any task tool and no risk of `task_output` polling tripping the
 * default loop detector. Hosts with spawn active (the TUI default)
 * get the full task surface; hosts without (`koi start`) get none,
 * matching main's pre-refactor capability surface.
 */
export const TASK_BOARD_TOOLS_HOST_KEY = "taskBoardTools";
/**
 * Key under `ctx.host` for the `bash_background` opt-in flag.
 *
 * When `true` (default), the execution stack contributes the
 * `bash_background` tool (detached shell subprocess launch). When
 * `false`, only the core synchronous `Bash` tool is exposed.
 *
 * `koi start` passes `false` because its auto-allow permission
 * backend + the engine's default loop detector make detached-
 * subprocess polling unsafe: repeated calls to the task board's
 * `task_output` would fingerprint identically and trip the 3-in-8
 * threshold. Without `bash_background` on the CLI there are no
 * long-running subprocesses, so the detector stays enabled as a
 * narrow guard against runaway mutating calls.
 *
 * Separate from this flag, `task_*` providers are gated via
 * `TASK_BOARD_TOOLS_HOST_KEY` so a TUI manifest that disables
 * `backgroundSubprocesses` still gets a working coordinator
 * surface (no bash_background, but task_* + Spawn are intact).
 */
export const BACKGROUND_SUBPROCESSES_HOST_KEY = "backgroundSubprocesses";

/**
 * Check whether a directory exists and is owned by the current uid.
 *
 * Rejects directories owned by other users to prevent command hijack
 * when `$HOME` is overridden or the process inherits a foreign env.
 */
function isOwnedDir(path: string, uid: number): boolean {
  try {
    const st = statSync(path);
    return st.isDirectory() && st.uid === uid;
  } catch {
    return false;
  }
}

/**
 * Detect common tool directories that exist on this host.
 *
 * Only directories that actually exist AND are owned by the current uid
 * are returned, keeping the subprocess PATH tight. Home-derived paths
 * are validated against the real uid to prevent command hijack when
 * `$HOME` is injected. Fixed system paths (`/opt/homebrew/bin`, etc.)
 * only need to exist.
 *
 * Closes #1841.
 */
interface ToolEnvConfig {
  /** PATH directories containing self-contained binaries (safe with any HOME). */
  readonly pathExtensions: readonly string[];
  /** PATH directories containing shims that depend on HOME for state (nvm, volta, pyenv). */
  readonly shimPathExtensions: readonly string[];
  /** Validated home directory, or undefined when ownership cannot be confirmed. */
  readonly home: string | undefined;
}

function detectToolEnv(): ToolEnvConfig {
  // Use passwd-backed home (os.userInfo().homedir) as the canonical
  // source. Unlike os.homedir(), this ignores $HOME env overrides and
  // reads directly from the passwd database, preventing same-uid HOME
  // injection from steering subprocess PATH and config.
  let canonicalHome: string | undefined;
  let uid: number | undefined;
  try {
    const info = userInfo();
    canonicalHome = info.homedir;
    uid = info.uid;
  } catch {
    uid = process.getuid?.();
  }

  // Fall back to env-derived home ONLY when it matches the canonical
  // home. If os.userInfo() failed entirely (no passwd entry), skip
  // home-derived paths since we cannot verify ownership.
  // homedir() can also throw on degraded NSS/passwd — guard it.
  let envHome: string | undefined;
  try {
    envHome = homedir();
  } catch {
    // Degraded host — no home discovery possible
  }
  const home = canonicalHome ?? undefined;
  const homeOwned =
    home !== undefined && uid !== undefined && home === envHome && isOwnedDir(home, uid);
  // Self-contained binaries — work correctly regardless of HOME value.
  const selfContainedCandidates: readonly string[] = homeOwned
    ? [
        join(home, ".bun", "bin"),
        join(home, ".local", "bin"),
        join(home, ".cargo", "bin"),
        join(home, "go", "bin"),
      ]
    : [];

  // Shim-based managers — depend on HOME for state resolution.
  // Only safe when HOME is propagated (unsandboxed mode).
  const shimCandidates: readonly string[] = homeOwned
    ? [
        join(home, ".nvm", "current", "bin"),
        join(home, ".fnm", "current", "bin"),
        join(home, ".volta", "bin"),
        join(home, ".pyenv", "shims"),
      ]
    : [];

  // Fixed system paths — no ownership check needed (system-managed).
  const systemCandidates: readonly string[] = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/sbin",
    "/usr/local/go/bin",
  ];

  return {
    pathExtensions: [...selfContainedCandidates, ...systemCandidates].filter((p) => existsSync(p)),
    shimPathExtensions: shimCandidates.filter((p) => existsSync(p)),
    home: homeOwned ? home : undefined,
  };
}

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
    // `bash_background` (detached subprocess launch) is independently
    // gated from task-board tool exposure. Defaults to `true`; hosts
    // opt out via `backgroundSubprocesses: false`.
    const backgroundSubprocessesEnabled =
      (ctx.host?.[BACKGROUND_SUBPROCESSES_HOST_KEY] as boolean | undefined) ?? true;
    // `task_*` providers are gated on whether the spawn stack is
    // active for this host. The factory computes that upstream (it
    // knows which stacks are in the enabled set) and threads the
    // decision through here. When `undefined`, default to `true` so
    // standalone tests / lightweight hosts that only pass the core
    // config get the coordinator surface they expect.
    const taskBoardToolsEnabled =
      (ctx.host?.[TASK_BOARD_TOOLS_HOST_KEY] as boolean | undefined) ?? true;

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

    // Detect user-installed tool paths and validated home at boot.
    // Both PATH extensions and HOME are derived from the same ownership-
    // validated source so the trust boundary is consistent.
    const toolEnv = detectToolEnv();

    // When sandboxed, keep HOME=/tmp (the SAFE_ENV default) because
    // the sandbox write-allowlist does not include $HOME — propagating
    // the real home would cause tool cache/config writes to fail.
    // Also exclude HOME-dependent shim paths (nvm, volta, pyenv) since
    // they require HOME for state resolution.
    const sandboxed = sandboxAdapter !== undefined && sandboxProfile !== undefined;
    const effectiveHome = sandboxed ? undefined : toolEnv.home;
    const effectivePaths = sandboxed
      ? toolEnv.pathExtensions
      : [...toolEnv.pathExtensions, ...toolEnv.shimPathExtensions];

    const bashHandle = createBashToolWithHooks({
      workspaceRoot: ctx.cwd,
      trackCwd: true,
      elicit: bashElicit,
      pathExtensions: effectivePaths,
      home: effectiveHome,
      ...(sandboxed ? { sandboxAdapter, sandboxProfile } : {}),
    });

    // --- Task board (always created — spawned coordinators need task_*) ---
    // Creation happens unconditionally so coordinator flows
    // (task_create → spawn → task_output) work on every host,
    // regardless of whether `bash_background` is enabled. Hosts
    // that skip background subprocesses still get the full
    // `task_*` tool set and the board stays in-memory for the
    // session.
    // let: mutable — rotated on session reset
    let bgController = new AbortController();
    // let: mutable — incremented/decremented from async completions.
    // When `backgroundSubprocessesEnabled` is false this never
    // changes from 0 because `bash_background` is the only wiring
    // that touches it, but the getter stays consistent across hosts.
    let liveSubprocessCount = 0;
    const boardRef: { current: ManagedTaskBoard } = {
      current:
        agentId !== undefined
          ? await createManagedTaskBoard({
              store: createMemoryTaskBoardStore(),
              resultsDir: join(tmpdir(), `koi-${ctx.hostId}-task-results`),
            })
          : // Stub board for hosts that didn't supply an agent id
            // (should never happen in practice; the factory always
            // precomputes one). Typed via `as` so the Proxy can bind.
            (undefined as unknown as ManagedTaskBoard),
    };
    const taskBoard = new Proxy({} as ManagedTaskBoard, {
      get(_target, prop, receiver) {
        const value = Reflect.get(boardRef.current, prop, receiver);
        return typeof value === "function" ? value.bind(boardRef.current) : value;
      },
    });

    // --- bash_background provider (gated by `backgroundSubprocesses`) ---
    const bashBackgroundProvider =
      backgroundSubprocessesEnabled && agentId !== undefined
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
                pathExtensions: effectivePaths,
                home: effectiveHome,
                ...(sandboxed ? { sandboxAdapter, sandboxProfile } : {}),
              }),
          })
        : undefined;

    // --- task_* tools (gated on spawn stack enablement) ---
    // Task board tools (task_create, task_delegate, task_output,
    // task_list, task_get, task_stop, task_update) exist to
    // orchestrate sub-agent coordinator flows. They're wired when
    // the spawn preset stack is active for this host and skipped
    // when spawn is excluded. This coupling is semantic, not
    // mechanical: without spawn there's nothing to delegate to and
    // nothing to poll, so the task board surface is vestigial —
    // and exposing it would put `koi start` back on the
    // `task_output` polling path the default loop detector hard-
    // fails on.
    //
    // Decoupling this from `backgroundSubprocesses` keeps TUI
    // manifests that set `backgroundSubprocesses: false` working:
    // the coordinator surface stays intact (spawn still active →
    // task_* still wired), only the detached-subprocess launcher
    // drops out.
    const taskToolProviders =
      taskBoardToolsEnabled && agentId !== undefined
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
        // Only the bash_background path tracks live subprocesses.
        // When it's disabled, the shutdown hook is a no-op.
        if (!backgroundSubprocessesEnabled) return false;
        const hadTasks = liveSubprocessCount > 0;
        bgController.abort();
        return hadTasks;
      },
      onResetSession: async () => {
        // 1. PRE-CREATE the new task board BEFORE anything else commits.
        //    Runs unconditionally because the task board is wired for
        //    every host (coordinator flows). If creation fails (sqlite
        //    disk full, permissions, etc.) we surface that before any
        //    destructive state mutation.
        const newBoard =
          agentId !== undefined
            ? await createManagedTaskBoard({
                store: createMemoryTaskBoardStore(),
                resultsDir: join(tmpdir(), `koi-${ctx.hostId}-task-results`),
              })
            : undefined;

        // 2. Snapshot whether we have live processes so the drain wait
        //    fires only when actually needed. Only meaningful when
        //    `bash_background` is enabled — otherwise `liveSubprocessCount`
        //    is always 0 and the branch is a no-op.
        const hadLiveProcesses = backgroundSubprocessesEnabled && liveSubprocessCount > 0;

        // 3. Abort the current controller — kills in-flight subprocesses.
        //    Only matters for hosts that enabled bash_background.
        if (backgroundSubprocessesEnabled) {
          bgController.abort();
          if (hadLiveProcesses) {
            await new Promise<void>((resolve) => setTimeout(resolve, SUBPROCESS_DRAIN_MS));
          }
        }

        // 4. Reset bash tracked CWD so the new session starts at workspace root.
        bashHandle.resetCwd();

        // 5. Rotate the controller so future launches use a fresh signal.
        //    Only meaningful when bash_background is enabled.
        if (backgroundSubprocessesEnabled) {
          bgController = new AbortController();
        }

        // 6. Atomic board swap — the proxy auto-sees the new instance on
        //    next Reflect.get, so cached tool providers don't need rebuilding.
        if (newBoard !== undefined) {
          boardRef.current = newBoard;
        }
      },
    };
  },
};
