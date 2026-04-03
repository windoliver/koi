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
  detectKoiPath,
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

/**
 * Compile-time-safe check identifiers. Dispatch repair actions on these
 * instead of display names so renames never silently break repair logic.
 */
export const CHECK_IDS = {
  SERVICE_FILE: "service_file",
  SERVICE_STATUS: "service_status",
  HEALTH_ENDPOINT: "health_endpoint",
  READINESS_ENDPOINT: "readiness_endpoint",
  BUN_RUNTIME: "bun_runtime",
  KOI_CLI: "koi_cli",
  LOGINCTL_LINGER: "loginctl_linger",
} as const;

export type CheckId = (typeof CHECK_IDS)[keyof typeof CHECK_IDS];

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  readonly id: CheckId;
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
  readonly repair?: boolean | undefined;
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
    return {
      id: CHECK_IDS.SERVICE_FILE,
      name: "Service file",
      status: "pass",
      message: `Found at ${filePath}`,
    };
  } catch {
    return {
      id: CHECK_IDS.SERVICE_FILE,
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
  const info = await manager.status(serviceName);

  if (info.status === "running") {
    return {
      id: CHECK_IDS.SERVICE_STATUS,
      name: "Service status",
      status: "pass",
      message: "Running",
    };
  }
  if (info.status === "failed") {
    return {
      id: CHECK_IDS.SERVICE_STATUS,
      name: "Service status",
      status: "fail",
      message: "Failed",
      fix: "Check logs with `koi logs` and restart with `koi deploy`",
    };
  }
  if (info.status === "stopped") {
    return {
      id: CHECK_IDS.SERVICE_STATUS,
      name: "Service status",
      status: "warn",
      message: "Stopped",
      fix: "Start the service with `koi deploy`",
    };
  }

  return {
    id: CHECK_IDS.SERVICE_STATUS,
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
      return {
        id: CHECK_IDS.HEALTH_ENDPOINT,
        name: "Health endpoint",
        status: "pass",
        message: `${url} → 200 OK`,
      };
    }
    return {
      id: CHECK_IDS.HEALTH_ENDPOINT,
      name: "Health endpoint",
      status: "fail",
      message: `${url} → ${res.status}`,
      fix: "Service may be starting up. Check logs with `koi logs`",
    };
  } catch {
    return {
      id: CHECK_IDS.HEALTH_ENDPOINT,
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
      return {
        id: CHECK_IDS.READINESS_ENDPOINT,
        name: "Readiness endpoint",
        status: "pass",
        message: `${url} → 200 OK`,
      };
    }
    if (res.status === 503) {
      return {
        id: CHECK_IDS.READINESS_ENDPOINT,
        name: "Readiness endpoint",
        status: "warn",
        message: `${url} → 503 Not Ready`,
        fix: "Service is alive but not ready. Check agent initialization logs",
      };
    }
    return {
      id: CHECK_IDS.READINESS_ENDPOINT,
      name: "Readiness endpoint",
      status: "fail",
      message: `${url} → ${res.status}`,
    };
  } catch {
    return {
      id: CHECK_IDS.READINESS_ENDPOINT,
      name: "Readiness endpoint",
      status: "warn",
      message: `${url} → unreachable (skipped, service may not be running)`,
    };
  }
}

function checkBunPath(): DiagnosticCheck {
  try {
    const path = detectBunPath();
    return {
      id: CHECK_IDS.BUN_RUNTIME,
      name: "Bun runtime",
      status: "pass",
      message: `Found at ${path}`,
    };
  } catch {
    return {
      id: CHECK_IDS.BUN_RUNTIME,
      name: "Bun runtime",
      status: "fail",
      message: "Bun binary not found",
      fix: "Install Bun: https://bun.sh",
    };
  }
}

function checkKoiPath(): DiagnosticCheck {
  try {
    const path = detectKoiPath(process.cwd());
    return { id: CHECK_IDS.KOI_CLI, name: "Koi CLI", status: "pass", message: `Found at ${path}` };
  } catch {
    return {
      id: CHECK_IDS.KOI_CLI,
      name: "Koi CLI",
      status: "fail",
      message: "koi binary not found",
      fix: "Ensure @koi/cli is installed or koi is in PATH",
    };
  }
}

async function checkLingerEnabled(): Promise<DiagnosticCheck> {
  const enabled = await isLingerEnabled();
  if (enabled) {
    return {
      id: CHECK_IDS.LOGINCTL_LINGER,
      name: "loginctl linger",
      status: "pass",
      message: "Enabled",
    };
  }
  return {
    id: CHECK_IDS.LOGINCTL_LINGER,
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
    checkKoiPath(),
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

// ---------------------------------------------------------------------------
// Repair — attempt to fix diagnosed issues automatically
// ---------------------------------------------------------------------------

export interface RepairResult {
  readonly repaired: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Attempt automatic repair for diagnosed failures.
 *
 * Currently supports:
 * - Restarting a stopped/failed service
 * - Enabling loginctl linger on Linux
 *
 * Repair actions are conservative — only act on issues with known fixes.
 */
export async function runRepair(
  report: DiagnosticReport,
  config: DoctorConfig,
): Promise<RepairResult> {
  const repaired: string[] = [];
  const skipped: string[] = [];

  const manager: ServiceManager =
    report.platform === "linux"
      ? createSystemdManager(config.system)
      : createLaunchdManager(
          config.system,
          config.logDir ?? resolveLogDir(report.platform, report.serviceName),
        );

  for (const check of report.checks) {
    if (check.status === "pass") continue;

    switch (check.id) {
      case CHECK_IDS.SERVICE_STATUS: {
        if (check.status === "warn" || check.status === "fail") {
          try {
            await manager.start(report.serviceName);
            repaired.push(`Restarted service "${report.serviceName}"`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            skipped.push(`Service restart failed: ${msg}`);
          }
        }
        break;
      }

      case CHECK_IDS.LOGINCTL_LINGER: {
        if (check.status === "warn" && report.platform === "linux") {
          try {
            const { execSync } = await import("node:child_process");
            execSync("loginctl enable-linger $USER", { stdio: "pipe" });
            repaired.push("Enabled loginctl linger");
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            skipped.push(`loginctl linger enable failed: ${msg}`);
          }
        }
        break;
      }

      default:
        if (check.fix !== undefined) {
          skipped.push(`${check.name}: manual fix required — ${check.fix}`);
        }
        break;
    }
  }

  return { repaired, skipped };
}
