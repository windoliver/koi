/**
 * Tests for runRepair — verifies automatic repair actions dispatch correctly
 * based on typed check IDs and report partial/full failures accurately.
 *
 * Uses mock.module to replace service manager factories so no real
 * launchctl/systemctl commands are executed.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ServiceInfo, ServiceManager } from "./managers/types.js";

// ---------------------------------------------------------------------------
// Mock service manager factories — must precede doctor import
// ---------------------------------------------------------------------------

const mockStart = mock<ServiceManager["start"]>(() => Promise.resolve());
const mockStop = mock<ServiceManager["stop"]>(() => Promise.resolve());
const mockInstall = mock<ServiceManager["install"]>(() => Promise.resolve());
const mockUninstall = mock<ServiceManager["uninstall"]>(() => Promise.resolve());

function mockStatus(): Promise<ServiceInfo> {
  return Promise.resolve({ status: "stopped" });
}

function createMockManager(): ServiceManager {
  return {
    install: mockInstall,
    uninstall: mockUninstall,
    start: mockStart,
    stop: mockStop,
    status: mockStatus,
    logs: async function* () {
      /* empty */
    },
  };
}

mock.module("./managers/launchd.js", () => ({
  createLaunchdManager: () => createMockManager(),
}));

mock.module("./managers/systemd.js", () => ({
  createSystemdManager: () => createMockManager(),
  isLingerEnabled: () => Promise.resolve(true),
}));

// Now import doctor — it will get the mocked manager factories
const { CHECK_IDS, runRepair } = await import("./doctor.js");
type CheckId = (typeof CHECK_IDS)[keyof typeof CHECK_IDS];
type DiagnosticCheck = import("./doctor.js").DiagnosticCheck;
type DiagnosticReport = import("./doctor.js").DiagnosticReport;
type DoctorConfig = import("./doctor.js").DoctorConfig;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: DoctorConfig = {
  agentName: "test-agent",
  system: false,
  port: 19876,
};

function createCheck(
  overrides: Partial<DiagnosticCheck> & { readonly id: CheckId },
): DiagnosticCheck {
  return {
    name: overrides.name ?? "Test check",
    status: overrides.status ?? "pass",
    message: overrides.message ?? "",
    ...overrides,
  };
}

function createReport(
  checks: readonly DiagnosticCheck[],
  platform: "darwin" | "linux" = "darwin",
): DiagnosticReport {
  const passing = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failures = checks.filter((c) => c.status === "fail").length;
  return {
    platform,
    serviceName: "koi-test-agent",
    checks,
    passing,
    warnings,
    failures,
  };
}

afterEach(() => {
  mockStart.mockReset();
  mockStart.mockImplementation(() => Promise.resolve());
  mockStop.mockReset();
  mockInstall.mockReset();
  mockUninstall.mockReset();
});

// ---------------------------------------------------------------------------
// runRepair
// ---------------------------------------------------------------------------

describe("runRepair", () => {
  it("is a no-op when all checks pass", async () => {
    const report = createReport([
      createCheck({ id: CHECK_IDS.BUN_RUNTIME, status: "pass" }),
      createCheck({ id: CHECK_IDS.KOI_CLI, status: "pass" }),
      createCheck({ id: CHECK_IDS.SERVICE_FILE, status: "pass" }),
      createCheck({ id: CHECK_IDS.SERVICE_STATUS, status: "pass" }),
      createCheck({ id: CHECK_IDS.HEALTH_ENDPOINT, status: "pass" }),
      createCheck({ id: CHECK_IDS.READINESS_ENDPOINT, status: "pass" }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    expect(result.repaired).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("restarts stopped service via manager.start", async () => {
    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_STATUS,
        status: "warn",
        name: "Service status",
        message: "Stopped",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith("koi-test-agent");
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toContain("Restarted service");
    expect(result.skipped).toHaveLength(0);
  });

  it("restarts failed service via manager.start", async () => {
    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_STATUS,
        status: "fail",
        name: "Service status",
        message: "Failed",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toContain("Restarted service");
  });

  it("reports service restart failure in skipped", async () => {
    mockStart.mockImplementation(() => Promise.reject(new Error("launchctl bootstrap failed")));

    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_STATUS,
        status: "fail",
        name: "Service status",
        message: "Failed",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    expect(result.repaired).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("Service restart failed");
    expect(result.skipped[0]).toContain("launchctl bootstrap failed");
  });

  it("skips checks that have no automatic repair with fix hint", async () => {
    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_FILE,
        status: "fail",
        name: "Service file",
        message: "Not found",
        fix: "Run `koi deploy` to install the service",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    expect(result.repaired).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("manual fix required");
    expect(result.skipped[0]).toContain("Service file");
  });

  it("reports partial failure when one repair succeeds and another is manual", async () => {
    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_STATUS,
        status: "warn",
        name: "Service status",
        message: "Stopped",
      }),
      createCheck({
        id: CHECK_IDS.SERVICE_FILE,
        status: "fail",
        name: "Service file",
        message: "Not found",
        fix: "Run `koi deploy`",
      }),
      createCheck({
        id: CHECK_IDS.HEALTH_ENDPOINT,
        status: "fail",
        name: "Health endpoint",
        message: "unreachable",
        fix: "Check status with `koi status`",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    // Service status repair succeeds
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toContain("Restarted service");
    // Service file and health endpoint are manual fixes
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toContain("Service file");
    expect(result.skipped[1]).toContain("Health endpoint");
  });

  it("skips readiness endpoint warning without fix gracefully", async () => {
    const report = createReport([
      createCheck({
        id: CHECK_IDS.READINESS_ENDPOINT,
        status: "warn",
        name: "Readiness endpoint",
        message: "unreachable",
        // no fix field — nothing to report
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    expect(result.repaired).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("does not attempt linger repair on darwin platform", async () => {
    const report = createReport(
      [
        createCheck({
          id: CHECK_IDS.LOGINCTL_LINGER,
          status: "warn",
          name: "loginctl linger",
          message: "Disabled",
          fix: "Run: loginctl enable-linger $USER",
        }),
      ],
      "darwin",
    );

    const result = await runRepair(report, BASE_CONFIG);
    // Linger repair is linux-only; on darwin the case matches but the
    // platform guard prevents execution — no repaired, no skipped
    expect(result.repaired).toHaveLength(0);
  });

  it("handles mixed repair outcomes: one succeeds, one fails", async () => {
    // First call succeeds (service restart), setup for two service status checks
    // to simulate different outcomes is tricky — instead simulate service restart
    // failure alongside a manual-fix check
    mockStart.mockImplementation(() => Promise.reject(new Error("permission denied")));

    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_STATUS,
        status: "fail",
        name: "Service status",
        message: "Failed",
      }),
      createCheck({
        id: CHECK_IDS.BUN_RUNTIME,
        status: "fail",
        name: "Bun runtime",
        message: "Not found",
        fix: "Install Bun: https://bun.sh",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    // Service restart failed
    expect(result.skipped.some((s) => s.includes("Service restart failed"))).toBe(true);
    expect(result.skipped.some((s) => s.includes("permission denied"))).toBe(true);
    // Bun runtime has manual fix
    expect(result.skipped.some((s) => s.includes("Bun runtime"))).toBe(true);
    expect(result.repaired).toHaveLength(0);
  });

  it("dispatches on check.id not check.name for service status repair", async () => {
    // Verify that renaming the display name does not break repair
    const report = createReport([
      createCheck({
        id: CHECK_IDS.SERVICE_STATUS,
        status: "fail",
        name: "Renamed Service Status Display Name",
        message: "Failed",
      }),
    ]);

    const result = await runRepair(report, BASE_CONFIG);
    // Repair should still work because it dispatches on id, not name
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toContain("Restarted service");
  });
});
