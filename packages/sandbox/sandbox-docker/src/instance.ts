import type { SandboxAdapterResult, SandboxInstance } from "@koi/core";
import type { DockerContainer } from "./types.js";

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function createDockerInstance(container: DockerContainer): SandboxInstance {
  return {
    exec: async (command, args, options): Promise<SandboxAdapterResult> => {
      const start = Date.now();
      const cmd = [command, ...args].map(quoteArg).join(" ");
      const result = await container.exec(cmd, {
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - start,
        timedOut: result.exitCode === 124,
        oomKilled: result.exitCode === 137,
      };
    },
    readFile: (path): Promise<Uint8Array> => container.readFile(path),
    writeFile: (path, content): Promise<void> => container.writeFile(path, content),
    destroy: async (): Promise<void> => {
      await container.stop();
      await container.remove();
    },
  };
}
