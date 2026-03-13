/**
 * DETACH phase — fork child process and exit parent.
 */

import { dirname, resolve } from "node:path";

export async function runDetach(manifestPath: string): Promise<never> {
  const { spawn } = await import("node:child_process");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const workspaceRoot = resolve(dirname(manifestPath));
  const args = process.argv.slice(1).filter((a) => a !== "--detach");
  const child = spawn(process.argv[0] ?? "bun", args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const pidDir = join(workspaceRoot, ".koi");
  await mkdir(pidDir, { recursive: true });
  await writeFile(join(pidDir, "koi.pid"), String(child.pid));
  process.stderr.write(`Detached. PID ${String(child.pid)} written to .koi/koi.pid\n`);
  process.exit(0);
}
