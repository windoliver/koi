/**
 * Service health diagnostics — `koi doctor` implementation.
 *
 * Runs a series of checks against a deployed service and reports issues.
 * Inspired by OpenClaw's `openclaw doctor`.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { createLaunchdManager } from "./managers/launchd.js";
import { createSystemdManager, isLingerEnabled } from "./managers/systemd.js";
import type { ServiceManager } from "./managers/types.js";
import {
  detectBunPath,
  detectPlatform,
  type Platform,
  resolveLaunchdLabel,
  resolveLogDir,
  resolveServiceDir,
  resolveServiceName,
} from "./platform.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly fix?: string | undefined;
}

export interface DiagnosticReport {
  readonly platform: Platform;
  readonly serviceName: string;
  readonly checks: readonly DiagnosticCheck[];
  readonly passing: number;
  readonly warnings: number;
  readonly failures: number;
}

export interface DoctorConfig {
  readonly agentName: string;
  readonly system: boolean;
  readonly port: number;
  readonly logDir?: string | undefined;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkServiceFile(
  platform: Platform,
  serviceName: string,
  agentName: string,
  system: boolean,
): Promise<DiagnosticCheck> {
  const serviceDir = resolveServiceDir(platform, system);
  // Linux uses "koi-<name>.service", macOS uses "com.koi.<name>.plist"
  const fileName =
    platform === "linux" ? `${serviceName}.service` : `${resolveLaunchdLabel(agentName)}.plist`;
  const filePath = join(serviceDir, fileName);

  try {
    await access(filePath);
    return { name: "Service file", status: "pass", message: `Found at ${filePath}` };
  } catch {
    return {
      name: "Service file",
      status: "fail",
      message: `Not found at ${filePath}`,
      fix: "Run `koi deploy` to install the service",
    };
  }
}

async function checkServiceStatus(
  manager: ServiceManager,
  serviceName: string,
): Promise<DiagnosticCheck> {
  const status = await manager.status(serviceName);

  if (status === "running") {
    return { name: "Service status", status: "pass", message: "Running" };
  }
  if (status === "failed") {
    return {
      name: "Service status",
      status: "fail",
      message: "Failed",
      fix: "Check logs with `koi logs` and restart with `koi deploy`",
    };
  }
  if (status === "stopped") {
    return {
      name: "Service status",
      status: "warn",
      message: "Stopped",
      fix: "Start the service with `koi deploy`",
    };
  }

  return {
    name: "Service status",
    status: "fail",
    message: "Not installed",
    fix: "Run `koi deploy` to install the service",
  };
}

async function checkHealthEndpoint(port: number): Promise<DiagnosticCheck> {
  const url = `http://localhost:${port}/health`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.status === 200) {
      return { name: "Health endpoint", status: "pass", message: `${url} → 200 OK` };
    }
    return {
      name: "Health endpoint",
      status: "fail",
      message: `${url} → ${res.status}`,
      fix: "Service may be starting up. Check logs with `koi logs`",
    };
  } catch {
    return {
      name: "Health endpoint",
      status: "fail",
      message: `${url} → unreachable`,
      fix: "Service may not be running. Check status with `koi status`",
    };
  }
}

async function checkReadinessEndpoint(port: number): Promise<DiagnosticCheck> {
  const url = `http://localhost:${port}/health/ready`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.status === 200) {
      return { name: "Readiness endpoint", status: "pass", message: `${url} → 200 OK` };
    }
    if (res.status === 503) {
      return {
        name: "Readiness endpoint",
        status: "warn",
        message: `${url} → 503 Not Ready`,
        fix: "Service is alive but not ready. Check agent initialization logs",
      };
    }
    return {
      name: "Readiness endpoint",
      status: "fail",
      message: `${url} → ${res.status}`,
    };
  } catch {
    return {
      name: "Readiness endpoint",
      status: "warn",
      message: `${url} → unreachable (skipped, service may not be running)`,
    };
  }
}

function checkBunPath(): DiagnosticCheck {
  try {
    const path = detectBunPath();
    return { name: "Bun runtime", status: "pass", message: `Found at ${path}` };
  } catch {
    return {
      name: "Bun runtime",
      status: "fail",
      message: "Bun binary not found",
      fix: "Install Bun: https://bun.sh",
    };
  }
}

async function checkLingerEnabled(): Promise<DiagnosticCheck> {
  const enabled = await isLingerEnabled();
  if (enabled) {
    return { name: "loginctl linger", status: "pass", message: "Enabled" };
  }
  return {
    name: "loginctl linger",
    status: "warn",
    message: "Disabled — user services will stop on logout",
    fix: "Run: loginctl enable-linger $USER",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runDiagnostics(config: DoctorConfig): Promise<DiagnosticReport> {
  const platform = detectPlatform();
  const serviceName = resolveServiceName(config.agentName);
  const logDir = config.logDir ?? resolveLogDir(platform, serviceName);

  const manager: ServiceManager =
    platform === "linux"
      ? createSystemdManager(config.system)
      : createLaunchdManager(config.system, logDir);

  // Run independent checks in parallel
  const [serviceFile, serviceStatus, health, readiness] = await Promise.all([
    checkServiceFile(platform, serviceName, config.agentName, config.system),
    checkServiceStatus(manager, serviceName),
    checkHealthEndpoint(config.port),
    checkReadinessEndpoint(config.port),
  ]);

  const checks: readonly DiagnosticCheck[] = [
    checkBunPath(),
    serviceFile,
    serviceStatus,
    health,
    readiness,
    ...(platform === "linux" && !config.system ? [await checkLingerEnabled()] : []),
  ];

  const passing = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failures = checks.filter((c) => c.status === "fail").length;

  return { platform, serviceName, checks, passing, warnings, failures };
}
