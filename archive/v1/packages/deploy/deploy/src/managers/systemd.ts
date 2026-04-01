/**
 * systemd service manager — wraps systemctl and journalctl via Bun.spawn().
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveServiceDir } from "../platform.js";
import { exec } from "./exec.js";
import type { LogOptions, ServiceInfo, ServiceManager } from "./types.js";

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Checks whether lingering is enabled for the current user. */
export async function isLingerEnabled(): Promise<boolean> {
  const user = process.env.USER ?? process.env.LOGNAME;
  if (user === undefined) return false;
  const result = await exec(["loginctl", "show-user", user, "--property=Linger"]);
  return result.stdout.trim() === "Linger=yes";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parses `systemctl show --property=...` output into a key-value map. */
function parseSystemctlShow(output: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    map.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  return map;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSystemdManager(system: boolean): ServiceManager {
  const userFlag: readonly string[] = system ? [] : ["--user"];
  const serviceDir = resolveServiceDir("linux", system);

  return {
    async install(serviceName, content) {
      const filePath = join(serviceDir, `${serviceName}.service`);
      await mkdir(serviceDir, { recursive: true });
      await writeFile(filePath, content, { mode: 0o644 });

      // Reload systemd so it picks up the new unit
      const reloadResult = await exec(["systemctl", ...userFlag, "daemon-reload"]);
      if (reloadResult.exitCode !== 0) {
        throw new Error(`Failed to reload systemd daemon: ${reloadResult.stderr}`);
      }
      // Enable the service to start on boot
      const enableResult = await exec(["systemctl", ...userFlag, "enable", serviceName]);
      if (enableResult.exitCode !== 0) {
        throw new Error(`Failed to enable ${serviceName}: ${enableResult.stderr}`);
      }

      // For user services: enable lingering so the service survives logout
      if (!system) {
        const user = process.env.USER ?? process.env.LOGNAME;
        if (user !== undefined) {
          await exec(["loginctl", "enable-linger", user]);
        }
      }
    },

    async uninstall(serviceName) {
      const disableResult = await exec(["systemctl", ...userFlag, "disable", serviceName]);
      if (disableResult.exitCode !== 0) {
        // Tolerate "not found" errors when the service is already removed
        const isBenign =
          disableResult.stderr.includes("not found") ||
          disableResult.stderr.includes("No such file");
        if (!isBenign) {
          throw new Error(`Failed to disable ${serviceName}: ${disableResult.stderr}`);
        }
      }
      const filePath = join(serviceDir, `${serviceName}.service`);
      try {
        await unlink(filePath);
      } catch (e: unknown) {
        const code =
          e instanceof Error && "code" in e ? (e as NodeJS.ErrnoException).code : undefined;
        if (code !== "ENOENT") {
          throw new Error(`Failed to remove service file ${filePath}`, { cause: e });
        }
      }
      const reloadResult = await exec(["systemctl", ...userFlag, "daemon-reload"]);
      if (reloadResult.exitCode !== 0) {
        throw new Error(`Failed to reload systemd daemon: ${reloadResult.stderr}`);
      }
    },

    async start(serviceName) {
      // Use restart to pick up config changes when the service is already running.
      // restart is a no-op → start when the service is not yet active.
      const result = await exec(["systemctl", ...userFlag, "restart", serviceName]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to start ${serviceName}: ${result.stderr}`);
      }
    },

    async stop(serviceName) {
      const result = await exec(["systemctl", ...userFlag, "stop", serviceName]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to stop ${serviceName}: ${result.stderr}`);
      }
    },

    async status(serviceName): Promise<ServiceInfo> {
      const result = await exec([
        "systemctl",
        ...userFlag,
        "show",
        "--property=ActiveState,MainPID,ExecMainStartTimestamp,MemoryCurrent",
        serviceName,
      ]);

      if (result.exitCode !== 0) return { status: "not-installed" };

      const props = parseSystemctlShow(result.stdout);
      const activeState = props.get("ActiveState") ?? "";
      const mainPid = Number.parseInt(props.get("MainPID") ?? "0", 10);
      const startTs = props.get("ExecMainStartTimestamp") ?? "";
      const memRaw = props.get("MemoryCurrent") ?? "";

      let status: ServiceInfo["status"];
      if (activeState === "active") status = "running";
      else if (activeState === "failed") status = "failed";
      else if (activeState === "inactive") status = "stopped";
      else status = "not-installed";

      const pid = mainPid > 0 ? mainPid : undefined;

      let uptimeMs: number | undefined;
      if (status === "running" && startTs.length > 0) {
        const startTime = Date.parse(startTs);
        if (!Number.isNaN(startTime)) {
          uptimeMs = Date.now() - startTime;
        }
      }

      let memoryBytes: number | undefined;
      if (memRaw.length > 0 && memRaw !== "[not set]") {
        const parsed = Number.parseInt(memRaw, 10);
        if (!Number.isNaN(parsed)) memoryBytes = parsed;
      }

      return { status, pid, uptimeMs, memoryBytes };
    },

    async *logs(serviceName: string, opts: LogOptions): AsyncIterable<string> {
      const args: readonly string[] = [
        "journalctl",
        ...userFlag,
        "-u",
        serviceName,
        "-n",
        String(opts.lines),
        "--no-pager",
        ...(opts.follow ? ["-f"] : []),
      ];

      const proc = Bun.spawn(args as string[], { stdout: "pipe", stderr: "pipe" });

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
        proc.kill();
      }
    },
  };
}
