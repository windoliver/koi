/**
 * LocalShellTask lifecycle — spawns a shell process and streams output.
 *
 * First concrete TaskKindLifecycle implementation. Validates the registry/runner
 * stack works end-to-end with real process management.
 */

import type { TaskItemId } from "@koi/core";
import type { TaskOutputStream } from "../output-stream.js";
import type { LocalShellTask } from "../task-kinds.js";
import type { TaskKindLifecycle } from "../task-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalShellConfig {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeout?: number | undefined;
  /**
   * Called when the subprocess exits naturally.
   * The runner uses this to transition the task on the board.
   */
  readonly onExit?: (code: number) => void;
}

const SAFE_ENV_KEYS: readonly string[] = [
  "PATH",
  "TMPDIR",
  "NODE_ENV",
  "BUN_INSTALL",
  "LANG",
  "LC_ALL",
];
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";

function buildLocalShellEnv(
  overrides: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? FALLBACK_PATH,
    HOME: "/tmp",
    TERM: "dumb",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}

let setsidPath: string | null | undefined;

function resolveSetsid(): string | null {
  if (setsidPath !== undefined) return setsidPath;
  try {
    const result = Bun.spawnSync(["which", "setsid"], { stdout: "pipe", stderr: "ignore" });
    const path = new TextDecoder().decode(new Uint8Array(result.stdout)).trim();
    setsidPath = result.exitCode === 0 && path.length > 0 ? path : null;
  } catch {
    setsidPath = null;
  }
  return setsidPath;
}

function signalProcess(
  proc: { readonly pid?: number; readonly kill: (signal?: number | NodeJS.Signals) => void },
  usedSetsid: boolean,
  signal: NodeJS.Signals,
): void {
  if (usedSetsid && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall through to direct child signal.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Already exited.
  }
}

// ---------------------------------------------------------------------------
// Stream piping helper
// ---------------------------------------------------------------------------

async function pipeStream(
  stream: ReadableStream<Uint8Array> | null,
  output: TaskOutputStream,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        output.write(decoder.decode(value, { stream: true }));
      }
    }
    // Flush any remaining bytes buffered in the decoder (e.g. split multibyte chars)
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      output.write(trailing);
    }
  } catch {
    // Stream may be closed when process is killed — swallow
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalShellLifecycle(): TaskKindLifecycle<LocalShellConfig, LocalShellTask> {
  return {
    kind: "local_shell",

    start: async (
      taskId: TaskItemId,
      output: TaskOutputStream,
      config: LocalShellConfig,
    ): Promise<LocalShellTask> => {
      const controller = new AbortController();

      const spawnOptions: {
        cwd?: string;
        env: Record<string, string>;
        stdout: "pipe";
        stderr: "pipe";
        signal: AbortSignal;
      } = {
        env: buildLocalShellEnv(config.env),
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      };
      if (config.cwd !== undefined) spawnOptions.cwd = config.cwd;

      const setsid = resolveSetsid();
      const usedSetsid = setsid !== null;
      const command =
        setsid !== null ? [setsid, "sh", "-c", config.command] : ["sh", "-c", config.command];
      const proc = Bun.spawn(command, spawnOptions);

      // Pipe stdout and stderr to the output stream (fire-and-forget)
      void pipeStream(proc.stdout, output);
      void pipeStream(proc.stderr, output);

      // Optional timeout
      // let justified: mutable because it's set conditionally and cleared on exit
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      const cancel = (): void => {
        if (cancelled) return;
        cancelled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        signalProcess(proc, usedSetsid, "SIGTERM");
        controller.abort();
        killTimer = setTimeout(() => {
          signalProcess(proc, usedSetsid, "SIGKILL");
        }, 500);
      };
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(cancel, config.timeout);
      }

      // Write exit code when process completes and notify runner
      void proc.exited.then((code) => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (killTimer !== undefined) clearTimeout(killTimer);
        output.write(`\n[exit code: ${String(code)}]\n`);
        config.onExit?.(code);
      });

      return {
        kind: "local_shell",
        taskId,
        command: config.command,
        cancel,
        output,
        startedAt: Date.now(),
      };
    },

    stop: async (state: LocalShellTask): Promise<void> => {
      state.cancel();
      // Give the process a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}
