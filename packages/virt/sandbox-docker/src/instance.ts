/**
 * Docker SandboxInstance implementation.
 */

import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import { createDestroyGuard, createOutputAccumulator } from "@koi/sandbox-cloud-base";
import { classifyDockerError } from "./classify.js";
import type { DockerNetworkConfig } from "./network.js";
import type { DockerContainer } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const IPTABLES_SCRIPT_PATH = "/tmp/.koi-iptables-setup.sh";

/** Shell-escape an argument by wrapping in single quotes. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Create a SandboxInstance backed by a Docker container. */
export function createDockerInstance(
  container: DockerContainer,
  networkConfig: DockerNetworkConfig,
): SandboxInstance {
  const guard = createDestroyGuard("docker");
  // let: mutable flag tracking whether iptables rules have been applied to this container
  let iptablesApplied = false;

  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      guard.check("exec");

      const startTime = performance.now();
      const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdoutAcc = createOutputAccumulator(maxOutputBytes);
      const stderrAcc = createOutputAccumulator(maxOutputBytes);

      try {
        // Apply iptables rules on first exec if needed
        if (!iptablesApplied && networkConfig.iptablesSetupScript !== undefined) {
          await container.writeFile(IPTABLES_SCRIPT_PATH, networkConfig.iptablesSetupScript);
          await container.exec(`sh ${IPTABLES_SCRIPT_PATH}`);
          iptablesApplied = true;
        }

        const baseCmd = args.length > 0 ? `${command} ${args.map(shellEscape).join(" ")}` : command;
        // Prepend cd for cwd support — Docker exec doesn't natively support workdir
        const fullCmd =
          options?.cwd !== undefined ? `cd ${shellEscape(options.cwd)} && ${baseCmd}` : baseCmd;

        const execOpts = {
          ...(options?.env !== undefined ? { env: options.env } : {}),
          ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        };

        // Enforce timeoutMs via a race with a timeout promise
        const timeoutMs = options?.timeoutMs;
        const execPromise = container.exec(fullCmd, execOpts);

        const result =
          timeoutMs !== undefined
            ? await Promise.race([
                execPromise,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Docker exec timed out after ${String(timeoutMs)}ms`)), timeoutMs),
                ),
              ])
            : await execPromise;
        const durationMs = performance.now() - startTime;

        // Accumulate output for truncation tracking
        stdoutAcc.append(result.stdout);
        stderrAcc.append(result.stderr);

        options?.onStdout?.(result.stdout);
        options?.onStderr?.(result.stderr);

        const stdoutResult = stdoutAcc.result();
        const stderrResult = stderrAcc.result();
        const truncated = stdoutResult.truncated || stderrResult.truncated;

        return {
          exitCode: result.exitCode,
          stdout: stdoutResult.output,
          stderr: stderrResult.output,
          durationMs,
          timedOut: false,
          oomKilled: false,
          ...(truncated ? { truncated } : {}),
        };
      } catch (e: unknown) {
        const durationMs = performance.now() - startTime;
        const classified = classifyDockerError(e, durationMs);

        return {
          exitCode: 1,
          stdout: "",
          stderr: classified.message,
          durationMs,
          timedOut: classified.code === "TIMEOUT",
          oomKilled: classified.code === "OOM",
        };
      }
    },

    readFile: async (path: string): Promise<Uint8Array> => {
      guard.check("readFile");
      const content = await container.readFile(path);
      return new TextEncoder().encode(content);
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      guard.check("writeFile");
      const text = new TextDecoder().decode(content);
      await container.writeFile(path, text);
    },

    destroy: async (): Promise<void> => {
      guard.markDestroyed();
      try {
        await container.stop();
      } finally {
        await container.remove();
      }
    },
  };
}
