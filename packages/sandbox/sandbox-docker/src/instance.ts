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

      // Pass signal directly to container.exec — runDockerExecBounded handles
      // pre-aborted check, mid-flight kill, and returns exitCode 130 on abort.
      const result = await container.exec(cmd, {
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.maxOutputBytes !== undefined
          ? { maxOutputBytes: options.maxOutputBytes }
          : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });

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
