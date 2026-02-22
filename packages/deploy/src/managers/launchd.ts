/**
 * launchd service manager — wraps launchctl for macOS.
 */

import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLaunchdLabel, resolveServiceDir } from "../platform.js";
import { exec } from "./exec.js";
import type { LogOptions, ServiceManager, ServiceStatus } from "./types.js";

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

    async status(serviceName): Promise<ServiceStatus> {
      const label = resolveLaunchdLabel(serviceName.replace(/^koi-/, ""));
      const result = await exec(["launchctl", "print", `${domain}/${label}`]);

      if (result.exitCode !== 0) return "not-installed";

      // Parse the output for state
      if (result.stdout.includes("state = running")) return "running";
      if (result.stdout.includes("state = waiting")) return "stopped";
      if (result.stdout.includes("last exit code")) {
        const exitMatch = result.stdout.match(/last exit code = (\d+)/);
        if (exitMatch !== null) {
          const code = Number.parseInt(exitMatch[1] ?? "0", 10);
          if (code !== 0) return "failed";
        }
      }

      return "stopped";
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
