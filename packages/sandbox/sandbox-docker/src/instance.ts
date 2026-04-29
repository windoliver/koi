import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { DockerContainer } from "./types.js";

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function createDockerInstance(container: DockerContainer): SandboxInstance {
  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      // Fail fast: streaming callbacks are not supported by this backend.
      // Callers should use exec() and read result.stdout/stderr instead.
      if (options?.onStdout !== undefined || options?.onStderr !== undefined) {
        throw new Error(
          "sandbox-docker: streaming callbacks (onStdout/onStderr) are not supported by the Docker backend; use exec() and read result.stdout/stderr instead",
        );
      }

      // If the signal is already aborted, return immediately without spawning.
      if (options?.signal?.aborted === true) {
        return {
          exitCode: 130,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          oomKilled: false,
          truncated: false,
        };
      }

      const start = Date.now();
      const cmd = [command, ...args].map(quoteArg).join(" ");

      // Wire abort signal → kill the docker exec process when aborted.
      // We pass a controller-like kill into container.exec by using the timeoutMs
      // approach below, but for AbortSignal we need a separate listener.
      // container.exec is backed by runDockerExecBounded which creates its own
      // Bun.spawn process. We implement abort by wrapping the exec promise with
      // a race against the signal.
      const execPromise = container.exec(cmd, {
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.maxOutputBytes !== undefined
          ? { maxOutputBytes: options.maxOutputBytes }
          : {}),
      });

      const signal = options?.signal;
      if (signal === undefined) {
        const result = await execPromise;
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - start,
          timedOut: result.exitCode === 124,
          oomKilled: result.exitCode === 137,
          // Only include truncated when the underlying result set it (exactOptionalPropertyTypes)
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        };
      }

      // Race the exec against the abort signal.
      // `let` justified: resolveAbort is captured from Promise constructor and invoked by listener.
      let resolveAbort: (() => void) | undefined;
      const abortPromise = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });

      const onAbort = (): void => {
        if (resolveAbort !== undefined) resolveAbort();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const winner = await Promise.race([
          execPromise.then((r) => ({ kind: "result" as const, result: r })),
          abortPromise.then(() => ({ kind: "aborted" as const })),
        ]);

        if (winner.kind === "aborted") {
          // Signal fired — result is still in-flight but we return abort sentinel.
          // exitCode 130 = convention for SIGINT-killed processes.
          return {
            exitCode: 130,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - start,
            timedOut: false,
            oomKilled: false,
            truncated: false,
          };
        }

        const result = winner.result;
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - start,
          timedOut: result.exitCode === 124,
          oomKilled: result.exitCode === 137,
          // Only include truncated when the underlying result set it (exactOptionalPropertyTypes)
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    readFile: (path: string): Promise<Uint8Array> => container.readFile(path),
    writeFile: (path: string, content: Uint8Array): Promise<void> =>
      container.writeFile(path, content),
    destroy: async (): Promise<void> => {
      // Attempt stop, but always proceed to remove for best-effort cleanup.
      // If stop fails, we still try remove — then surface the stop error.
      let stopError: unknown;
      try {
        await container.stop();
      } catch (e: unknown) {
        stopError = e;
      }
      await container.remove();
      if (stopError !== undefined) throw stopError;
    },
  };
}
