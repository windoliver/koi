/**
 * @koi/deploy — Background service management for Koi agents.
 *
 * Generates OS-native service files (systemd/launchd), installs/uninstalls
 * services, provides health check HTTP server, and manages service lifecycle.
 *
 * Zero @koi/core dependency — this is a standalone L2 utility package.
 */

// Diagnostics
export type { CheckStatus, DiagnosticCheck, DiagnosticReport, DoctorConfig } from "./doctor.js";
export { runDiagnostics } from "./doctor.js";

// Health server
export type { HealthServer, HealthServerConfig } from "./health-server.js";
export { createHealthHandler, createHealthServer } from "./health-server.js";

// Install/uninstall
export type { InstallConfig, InstallResult } from "./install.js";
export { installService } from "./install.js";
// Service managers
export { createLaunchdManager } from "./managers/launchd.js";
export { createSystemdManager, isLingerEnabled } from "./managers/systemd.js";
export type { LogOptions, ServiceManager, ServiceStatus } from "./managers/types.js";
// Platform detection
export type { Platform } from "./platform.js";
export {
  detectBunPath,
  detectPlatform,
  resolveLaunchdLabel,
  resolveLogDir,
  resolveServiceDir,
  resolveServiceName,
} from "./platform.js";
// Templates
export type { LaunchdTemplateConfig } from "./templates/launchd.js";
export { renderLaunchdPlist } from "./templates/launchd.js";
export type { SystemdTemplateConfig } from "./templates/systemd.js";
export { renderSystemdUnit } from "./templates/systemd.js";
// Shared types
export type { DeployConfig } from "./types.js";
export type { UninstallConfig, UninstallResult } from "./uninstall.js";
export { uninstallService } from "./uninstall.js";
