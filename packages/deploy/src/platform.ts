/**
 * Platform detection and path resolution for service deployment.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Platform = "linux" | "darwin";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Detects the current OS platform. Throws on unsupported platforms. */
export function detectPlatform(): Platform {
  const p = process.platform;
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  throw new Error(`Unsupported platform: ${p}. Only linux and darwin are supported.`);
}

/** Finds the path to the `bun` binary. */
export function detectBunPath(): string {
  // Bun.which is available in Bun runtime
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const found = Bun.which("bun");
    if (found !== null) return found;
  }
  return process.execPath;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Converts an agent name to a service name: "my-agent" → "koi-my-agent". */
export function resolveServiceName(agentName: string): string {
  // Sanitize: lowercase, replace non-alphanumeric with hyphens
  const sanitized = agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `koi-${sanitized}`;
}

/** Converts an agent name to a launchd label: "my-agent" → "com.koi.my-agent". */
export function resolveLaunchdLabel(agentName: string): string {
  const sanitized = agentName
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `com.koi.${sanitized}`;
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/** Resolves the service file directory for the given platform and scope. */
export function resolveServiceDir(platform: Platform, system: boolean): string {
  if (platform === "linux") {
    return system ? "/etc/systemd/system" : join(homedir(), ".config/systemd/user");
  }
  // darwin
  return system ? "/Library/LaunchDaemons" : join(homedir(), "Library/LaunchAgents");
}

/** Resolves the default log directory for a service. */
export function resolveLogDir(platform: Platform, serviceName: string): string {
  if (platform === "linux") {
    // systemd uses journald — no log files needed
    return join(homedir(), ".local/share/koi/logs");
  }
  // darwin: launchd uses file-based logging
  return join(homedir(), "Library/Logs/Koi", serviceName);
}
