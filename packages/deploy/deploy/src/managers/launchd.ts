/**
 * launchd service manager — wraps launchctl for macOS.
 */

import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLaunchdLabel, resolveServiceDir } from "../platform.js";
import { exec } from "./exec.js";
import type { LogOptions, ServiceInfo, ServiceManager } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses `ps -o rss=,etime=` output into memoryBytes and uptimeMs.
 * RSS is in KB. Elapsed time format: [[DD-]HH:]MM:SS
 */
function parsePsOutput(output: string): {
  readonly uptimeMs?: number;
  readonly memoryBytes?: number;
} {
  const parts = output.trim().split(/\s+/);
  if (parts.length < 2) return {};

  const rssKb = Number.parseInt(parts[0] ?? "0", 10);
  const memoryBytes = Number.isNaN(rssKb) ? undefined : rssKb * 1024;

  const uptimeMs = parseEtime(parts[1] ?? "");

  return {
    ...(memoryBytes !== undefined ? { memoryBytes } : {}),
    ...(uptimeMs !== undefined ? { uptimeMs } : {}),
  };
}

/**
 * Parses ps elapsed time format into milliseconds.
 * Formats: MM:SS, HH:MM:SS, DD-HH:MM:SS
 */
function parseEtime(etime: string): number | undefined {
  let days = 0;
  let rest = etime;

  // Handle "DD-" prefix
  const dayMatch = rest.match(/^(\d+)-(.+)$/);
  if (dayMatch !== null) {
    days = Number.parseInt(dayMatch[1] ?? "0", 10);
    rest = dayMatch[2] ?? "";
  }

  const segments = rest.split(":").map((s) => Number.parseInt(s, 10));
  if (segments.some(Number.isNaN)) return undefined;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (segments.length === 3) {
    [hours, minutes, seconds] = segments as [number, number, number];
  } else if (segments.length === 2) {
    [minutes, seconds] = segments as [number, number];
  } else {
    return undefined;
  }

  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLaunchdManager(system: boolean, logDir: string): ServiceManager {
  const serviceDir = resolveServiceDir("darwin", system);
  const domain = system ? "system" : `gui/${process.getuid?.() ?? 501}`;

  return {
    async install(serviceName, content) {
      // Derive plist filename from service name
      const label = resolveLaunchdLabel(serviceName.replace(/^koi-/, ""));
      const filePath = join(serviceDir, `${label}.plist`);

      await mkdir(serviceDir, { recursive: true });
      await mkdir(logDir, { recursive: true });
      await writeFile(filePath, content, { mode: 0o644 });

      // Bootstrap the service
      await exec(["launchctl", "bootstrap", domain, filePath]);
    },

    async uninstall(serviceName) {
      const label = resolveLaunchdLabel(serviceName.replace(/^koi-/, ""));
      const filePath = join(serviceDir, `${label}.plist`);

      // Bootout ignores if not loaded
      await exec(["launchctl", "bootout", `${domain}/${label}`]);

      try {
        await unlink(filePath);
      } catch (e: unknown) {
        const code =
          e instanceof Error && "code" in e ? (e as NodeJS.ErrnoException).code : undefined;
        if (code !== "ENOENT") {
          throw new Error(`Failed to remove service file ${filePath}`, { cause: e });
        }
      }
    },

    async start(serviceName) {
      const label = resolveLaunchdLabel(serviceName.replace(/^koi-/, ""));
      const result = await exec(["launchctl", "kickstart", "-k", `${domain}/${label}`]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to start ${serviceName}: ${result.stderr}`);
      }
    },

    async stop(serviceName) {
      const label = resolveLaunchdLabel(serviceName.replace(/^koi-/, ""));
      const result = await exec(["launchctl", "kill", "SIGTERM", `${domain}/${label}`]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to stop ${serviceName}: ${result.stderr}`);
      }
    },

    async status(serviceName): Promise<ServiceInfo> {
      const label = resolveLaunchdLabel(serviceName.replace(/^koi-/, ""));
      const result = await exec(["launchctl", "print", `${domain}/${label}`]);

      if (result.exitCode !== 0) return { status: "not-installed" };

      // Parse PID from "pid = <N>"
      const pidMatch = result.stdout.match(/pid\s*=\s*(\d+)/);
      const pid = pidMatch !== null ? Number.parseInt(pidMatch[1] ?? "0", 10) : undefined;

      // Determine service status
      let status: ServiceInfo["status"] = "stopped";
      if (result.stdout.includes("state = running")) {
        status = "running";
      } else if (result.stdout.includes("state = waiting")) {
        status = "stopped";
      } else if (result.stdout.includes("last exit code")) {
        const exitMatch = result.stdout.match(/last exit code = (\d+)/);
        if (exitMatch !== null) {
          const code = Number.parseInt(exitMatch[1] ?? "0", 10);
          if (code !== 0) status = "failed";
        }
      }

      // If running and PID found, get memory and uptime from ps
      if (status === "running" && pid !== undefined && pid > 0) {
        const psResult = await exec(["ps", "-o", "rss=,etime=", "-p", String(pid)]);
        if (psResult.exitCode === 0) {
          const parsed = parsePsOutput(psResult.stdout.trim());
          return { status, pid, ...parsed };
        }
      }

      return { status, pid };
    },

    async *logs(_serviceName: string, opts: LogOptions): AsyncIterable<string> {
      const logFile = join(logDir, "stdout.log");

      // Check if log file exists
      try {
        await access(logFile);
      } catch {
        yield `No logs found at ${logFile}\n`;
        return;
      }

      const args: readonly string[] = [
        "tail",
        ...(opts.follow ? ["-f"] : []),
        "-n",
        String(opts.lines),
        logFile,
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
