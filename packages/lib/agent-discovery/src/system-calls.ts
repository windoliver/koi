import type { SystemCalls } from "./types.js";

export function createDefaultSystemCalls(): SystemCalls {
  return {
    which: async (b) => {
      const path = Bun.which(b);
      return path ?? null;
    },
    readDir: async (path) => {
      const glob = new Bun.Glob("*.json");
      const out: string[] = [];
      for (const name of glob.scanSync({ cwd: path, onlyFiles: true })) {
        out.push(name);
      }
      return out;
    },
    readFile: async (path) => Bun.file(path).text(),
    spawn: async (cmd, timeoutMs) => {
      const proc = Bun.spawn({
        cmd: [...cmd],
        stdout: "pipe",
        stderr: "ignore",
        timeout: timeoutMs,
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    },
  };
}
