import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type {
  KoiError,
  Result,
  WorkerBackend,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core";

interface RunTmuxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunTmux = (args: readonly string[]) => Promise<RunTmuxResult>;

interface CreateTmuxBackendOptions {
  readonly cwd?: string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly pruneGraceMs?: number;
  readonly runTmux?: RunTmux;
}

interface TmuxWorkerState {
  readonly controller: AbortController;
  readonly events: WorkerEvent[];
  readonly sessionName: string;
  readonly windowTarget: string;
  readonly paneId: string;
  panePid: number | undefined;
  alive: boolean;
  terminatedIntentionally: boolean;
  terminalDelivered: boolean;
  terminalEvent: WorkerEvent | undefined;
  pruneTimer: ReturnType<typeof setTimeout> | undefined;
}

interface PaneSnapshotAlive {
  readonly kind: "alive";
  readonly pid: number | undefined;
}

interface PaneSnapshotDead {
  readonly kind: "dead";
  readonly exitCode: number;
  readonly pid: number | undefined;
}

interface PaneSnapshotMissing {
  readonly kind: "missing";
  readonly stderr: string;
}

type PaneSnapshot = PaneSnapshotAlive | PaneSnapshotDead | PaneSnapshotMissing;

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_PRUNE_GRACE_MS = 30_000;
const SPAWN_FORMAT = "#{session_name}\t#{session_name}:#{window_index}\t#{pane_id}\t#{pane_pid}";
const PANE_STATE_FORMAT = "#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}";

export function createTmuxBackend(options: CreateTmuxBackendOptions = {}): WorkerBackend {
  const rootCwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const pruneGraceMs = Math.max(1, options.pruneGraceMs ?? DEFAULT_PRUNE_GRACE_MS);
  const runTmux = options.runTmux ?? createDefaultRunTmux(rootCwd);
  const workers = new Map<WorkerId, TmuxWorkerState>();

  const sessionNameFor = (cwd: string | undefined): string => {
    return `${createWorktreeSlug(cwd ?? rootCwd)}-daemon-workers`;
  };

  const emit = (id: WorkerId, state: TmuxWorkerState, ev: WorkerEvent): void => {
    state.events.push(ev);
    if (ev.kind === "exited" || ev.kind === "crashed") {
      state.alive = false;
      state.terminalEvent = ev;
      state.controller.abort();
      if (state.pruneTimer === undefined) {
        state.pruneTimer = setTimeout(() => {
          if (!state.terminalDelivered && workers.get(id) === state) {
            workers.delete(id);
          }
        }, pruneGraceMs);
      }
    }
  };

  const emitTerminal = (
    id: WorkerId,
    state: TmuxWorkerState,
    outcome: PaneSnapshot,
    fallbackCode: number,
  ): void => {
    if (state.terminalEvent !== undefined) return;

    if (outcome.kind === "alive") {
      state.alive = true;
      if (outcome.pid !== undefined) state.panePid = outcome.pid;
      return;
    }

    if (outcome.kind === "dead") {
      const code = Number.isFinite(outcome.exitCode) ? outcome.exitCode : fallbackCode;
      if (outcome.pid !== undefined) state.panePid = outcome.pid;
      emit(
        id,
        state,
        code === 0 || state.terminatedIntentionally
          ? {
              kind: "exited",
              workerId: id,
              at: now(),
              code,
              state: "terminated",
            }
          : {
              kind: "crashed",
              workerId: id,
              at: now(),
              error: {
                code: "INTERNAL",
                message: `tmux pane ${state.paneId} exited with code ${code}`,
                retryable: true,
              },
            },
      );
      return;
    }

    emit(
      id,
      state,
      state.terminatedIntentionally
        ? {
            kind: "exited",
            workerId: id,
            at: now(),
            code: fallbackCode,
            state: "terminated",
          }
        : {
            kind: "crashed",
            workerId: id,
            at: now(),
            error: {
              code: "INTERNAL",
              message:
                outcome.stderr.length > 0
                  ? `tmux pane ${state.paneId} is missing: ${outcome.stderr}`
                  : `tmux pane ${state.paneId} is missing`,
              retryable: true,
            },
          },
    );
  };

  const refreshWorkerState = async (
    id: WorkerId,
    state: TmuxWorkerState,
    fallbackCode: number,
  ): Promise<boolean> => {
    if (state.terminalEvent !== undefined) return false;
    const snapshot = await inspectPane(runTmux, state.paneId);
    emitTerminal(id, state, snapshot, fallbackCode);
    return state.alive;
  };

  const spawn = async (request: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
    if (request.command.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "WorkerSpawnRequest.command must be non-empty",
          retryable: false,
        },
      };
    }

    const availability = await runTmux(["-V"]).catch((error: unknown) => ({
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    if (availability.code !== 0) {
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message:
            availability.stderr.length > 0 ? availability.stderr : "tmux is not available on PATH",
          retryable: false,
        },
      };
    }

    const workerCwd = request.cwd ?? rootCwd;
    const sessionName = sessionNameFor(workerCwd);
    const sessionTarget = `${sessionName}:0`;
    const exists = await runTmux(["has-session", "-t", sessionName]);
    const createdNewSession = exists.code !== 0;
    const createArgs =
      exists.code === 0
        ? ["split-window", "-d", "-t", sessionTarget, "-c", workerCwd, "-P", "-F", SPAWN_FORMAT]
        : ["new-session", "-d", "-s", sessionName, "-c", workerCwd, "-P", "-F", SPAWN_FORMAT];
    const created = await runTmux(createArgs);
    if (created.code !== 0) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            created.stderr.length > 0
              ? `Failed to create tmux pane: ${created.stderr}`
              : "Failed to create tmux pane",
          retryable: true,
        },
      };
    }

    const pane = parseSpawnResult(created.stdout);
    if (!pane.ok) {
      await cleanupSpawnArtifacts(runTmux, sessionName, undefined, createdNewSession);
      return pane;
    }

    const titleResult = await runTmux([
      "select-pane",
      "-t",
      pane.value.paneId,
      "-T",
      String(request.workerId),
    ]);
    if (titleResult.code !== 0) {
      await cleanupSpawnArtifacts(
        runTmux,
        pane.value.sessionName,
        pane.value.paneId,
        createdNewSession,
      );
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            titleResult.stderr.length > 0
              ? `Failed to title tmux pane: ${titleResult.stderr}`
              : "Failed to title tmux pane",
          retryable: true,
        },
      };
    }

    const sendResult = await runTmux([
      "send-keys",
      "-t",
      pane.value.paneId,
      joinShellWords(request.command),
      "Enter",
    ]);
    if (sendResult.code !== 0) {
      await cleanupSpawnArtifacts(
        runTmux,
        pane.value.sessionName,
        pane.value.paneId,
        createdNewSession,
      );
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            sendResult.stderr.length > 0
              ? `Failed to launch command in tmux pane: ${sendResult.stderr}`
              : "Failed to launch command in tmux pane",
          retryable: true,
        },
      };
    }

    const controller = new AbortController();
    const state: TmuxWorkerState = {
      controller,
      events: [],
      sessionName: pane.value.sessionName,
      windowTarget: pane.value.windowTarget,
      paneId: pane.value.paneId,
      panePid: pane.value.panePid,
      alive: true,
      terminatedIntentionally: false,
      terminalDelivered: false,
      terminalEvent: undefined,
      pruneTimer: undefined,
    };
    workers.set(request.workerId, state);
    emit(request.workerId, state, {
      kind: "started",
      workerId: request.workerId,
      at: now(),
      ...(pane.value.panePid !== undefined && { pid: pane.value.panePid }),
    });

    const handle: WorkerHandle = {
      workerId: request.workerId,
      agentId: request.agentId,
      backendKind: "tmux",
      tmuxSessionName: state.sessionName,
      tmuxWindowTarget: state.windowTarget,
      tmuxPaneId: state.paneId,
      startedAt: now(),
      signal: controller.signal,
    };
    return { ok: true, value: handle };
  };

  const terminate = async (id: WorkerId, _reason: string): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };

    state.terminatedIntentionally = true;
    const interrupt = await runTmux(["send-keys", "-t", state.paneId, "C-c"]);
    if (interrupt.code !== 0 && !isMissingPaneError(interrupt.stderr)) {
      return tmuxFailure("Failed to interrupt tmux pane", interrupt.stderr);
    }

    const exit = await runTmux(["send-keys", "-t", state.paneId, "exit", "Enter"]);
    if (exit.code !== 0 && !isMissingPaneError(exit.stderr)) {
      return tmuxFailure("Failed to exit tmux pane", exit.stderr);
    }

    await refreshWorkerState(id, state, 0);
    return { ok: true, value: undefined };
  };

  const kill = async (id: WorkerId): Promise<Result<void, KoiError>> => {
    const state = workers.get(id);
    if (state === undefined) return { ok: true, value: undefined };

    state.terminatedIntentionally = true;
    const killed = await runTmux(["kill-pane", "-t", state.paneId]);
    if (killed.code !== 0 && !isMissingPaneError(killed.stderr)) {
      return tmuxFailure("Failed to kill tmux pane", killed.stderr);
    }

    await refreshWorkerState(id, state, 137);
    return { ok: true, value: undefined };
  };

  const isAlive = async (id: WorkerId): Promise<boolean> => {
    const state = workers.get(id);
    if (state === undefined) return false;
    if (!state.alive) return false;
    return refreshWorkerState(id, state, 0);
  };

  const watch = async function* (id: WorkerId, signal?: AbortSignal): AsyncIterable<WorkerEvent> {
    const state = workers.get(id);
    if (state === undefined) return;
    if (signal?.aborted) return;

    let cancelResolve: (() => void) | undefined;
    const onAbort = (): void => {
      if (cancelResolve !== undefined) {
        const resolve = cancelResolve;
        cancelResolve = undefined;
        resolve();
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      let cursor = 0;
      while (cursor < state.events.length) {
        const ev = state.events[cursor++];
        if (ev === undefined) break;
        yield ev;
        if (isTerminalEvent(ev)) {
          state.terminalDelivered = true;
          return;
        }
      }

      while (true) {
        if (signal?.aborted) return;

        await refreshWorkerState(id, state, state.terminatedIntentionally ? 0 : 1);
        while (cursor < state.events.length) {
          const ev = state.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (isTerminalEvent(ev)) {
            state.terminalDelivered = true;
            return;
          }
        }
        if (!state.alive) {
          state.terminalDelivered = true;
          return;
        }

        const result = await new Promise<"tick" | "cancel">((resolve) => {
          const timer = setTimeout(() => resolve("tick"), pollIntervalMs);
          cancelResolve = (): void => {
            clearTimeout(timer);
            resolve("cancel");
          };
        });
        cancelResolve = undefined;
        if (result === "cancel") return;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (cancelResolve !== undefined) {
        const resolve = cancelResolve;
        cancelResolve = undefined;
        resolve();
      }
      if (state.terminalDelivered && state.pruneTimer !== undefined) {
        clearTimeout(state.pruneTimer);
        state.pruneTimer = undefined;
      }
      if (state.terminalDelivered && workers.get(id) === state) {
        workers.delete(id);
      }
    }
  };

  return {
    kind: "tmux",
    displayName: "tmux panes",
    isAvailable: async () => {
      try {
        const result = await runTmux(["-V"]);
        return result.code === 0;
      } catch {
        return false;
      }
    },
    spawn,
    terminate,
    kill,
    isAlive,
    watch,
  };
}

function createDefaultRunTmux(cwd: string): RunTmux {
  return async (args: readonly string[]): Promise<RunTmuxResult> => {
    const proc = Bun.spawn(["tmux", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return {
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  };
}

async function cleanupSpawnArtifacts(
  runTmux: RunTmux,
  sessionName: string,
  paneId: string | undefined,
  createdNewSession: boolean,
): Promise<void> {
  if (paneId !== undefined) {
    const killed = await runTmux(["kill-pane", "-t", paneId]);
    if (killed.code === 0 || isMissingPaneError(killed.stderr)) return;
  }
  if (createdNewSession) {
    await runTmux(["kill-session", "-t", sessionName]);
  }
}

function parseSpawnResult(stdout: string): Result<
  {
    readonly sessionName: string;
    readonly windowTarget: string;
    readonly paneId: string;
    readonly panePid: number | undefined;
  },
  KoiError
> {
  const [sessionName, windowTarget, paneId, panePidText] = stdout.trim().split("\t");
  if (
    sessionName === undefined ||
    sessionName.length === 0 ||
    windowTarget === undefined ||
    windowTarget.length === 0 ||
    paneId === undefined ||
    paneId.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `tmux returned malformed pane metadata: ${stdout.trim()}`,
        retryable: true,
      },
    };
  }

  const panePid =
    panePidText !== undefined && panePidText.length > 0 && Number.isFinite(Number(panePidText))
      ? Number(panePidText)
      : undefined;

  return {
    ok: true,
    value: { sessionName, windowTarget, paneId, panePid },
  };
}

async function inspectPane(runTmux: RunTmux, paneId: string): Promise<PaneSnapshot> {
  const result = await runTmux(["display-message", "-p", "-t", paneId, PANE_STATE_FORMAT]);
  if (result.code !== 0) {
    return { kind: "missing", stderr: result.stderr };
  }

  const [deadText, exitCodeText, pidText] = result.stdout.trim().split("\t");
  const pid =
    pidText !== undefined && pidText.length > 0 && Number.isFinite(Number(pidText))
      ? Number(pidText)
      : undefined;
  if (deadText === "0") return { kind: "alive", pid };
  return {
    kind: "dead",
    exitCode: Number.isFinite(Number(exitCodeText)) ? Number(exitCodeText) : 1,
    pid,
  };
}

function isMissingPaneError(stderr: string): boolean {
  const value = stderr.toLowerCase();
  return value.includes("can't find pane") || value.includes("pane not found");
}

function isTerminalEvent(ev: WorkerEvent): boolean {
  return ev.kind === "exited" || ev.kind === "crashed";
}

function joinShellWords(command: readonly string[]): string {
  return command.map(shellEscape).join(" ");
}

function shellEscape(part: string): string {
  return `'${part.replace(/'/g, `'"'"'`)}'`;
}

function tmuxFailure(message: string, stderr: string): Result<void, KoiError> {
  return {
    ok: false,
    error: {
      code: "INTERNAL",
      message: stderr.length > 0 ? `${message}: ${stderr}` : message,
      retryable: true,
    },
  };
}

function createWorktreeSlug(cwd: string): string {
  const absolute = resolve(cwd);
  const parts = absolute
    .split(sep)
    .filter((part) => part.length > 0)
    .map(sanitizeSlugPart)
    .filter((part) => part.length > 0);
  const tail = parts.slice(-2);
  const prefix = (tail.length > 0 ? tail : ["koi"]).join("-");
  const hash = createHash("sha1").update(absolute).digest("hex").slice(0, 8);
  return `${prefix}-${hash}`;
}

function sanitizeSlugPart(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
