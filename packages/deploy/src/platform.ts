/**
 * Platform detection and path resolution for service deployment.
 */

import { accessSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/**
 * Finds the path to the `koi` CLI entry point.
 *
 * Resolution order:
 * 1. Bun.which("koi") — globally installed or in PATH
 * 2. node_modules/.bin/koi relative to workDir — npm/bun linked binary
 * 3. @koi/cli dist/bin.js relative to workDir — monorepo dev layout
 *
 * Throws if no koi binary can be found.
 */
export function detectKoiPath(workDir: string): string {
  // 1. Check PATH
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const found = Bun.which("koi");
    if (found !== null) return found;
  }

  // 2. Check node_modules/.bin/koi (standard install)
  const nmBin = resolve(workDir, "node_modules/.bin/koi");
  if (fileExists(nmBin)) return nmBin;

  // 3. Check monorepo layout: @koi/cli package dist
  const monorepoPath = resolve(workDir, "packages/cli/dist/bin.js");
  if (fileExists(monorepoPath)) return monorepoPath;

  // 4. Check relative to this package (e.g., ../../cli/dist/bin.js)
  const relativePath = resolve(workDir, "node_modules/@koi/cli/dist/bin.js");
  if (fileExists(relativePath)) return relativePath;

  throw new Error("Could not find koi CLI. Ensure @koi/cli is installed or koi is in PATH.");
}

function fileExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
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
