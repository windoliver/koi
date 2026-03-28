import { describe, expect, it } from "bun:test";
import type { DoctorConfig } from "./doctor.js";
import { CHECK_IDS, runDiagnostics } from "./doctor.js";

const BASE_CONFIG: DoctorConfig = {
  agentName: "test-agent",
  system: false,
  port: 19876, // high port unlikely to be in use
};

// ---------------------------------------------------------------------------
// runDiagnostics
// ---------------------------------------------------------------------------

describe("runDiagnostics", () => {
  it("returns a diagnostic report with expected shape", async () => {
    const report = await runDiagnostics(BASE_CONFIG);

    expect(report.platform).toMatch(/^(linux|darwin)$/);
    expect(report.serviceName).toBe("koi-test-agent");
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    expect(typeof report.passing).toBe("number");
    expect(typeof report.warnings).toBe("number");
    expect(typeof report.failures).toBe("number");
    expect(report.passing + report.warnings + report.failures).toBe(report.checks.length);
  });

  it("always includes bun runtime check", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const bunCheck = report.checks.find((c) => c.id === CHECK_IDS.BUN_RUNTIME);
    expect(bunCheck).toBeDefined();
    // Bun is available since we're running in bun:test
    expect(bunCheck?.status).toBe("pass");
  });

  it("reports service file as fail when not installed", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const fileCheck = report.checks.find((c) => c.id === CHECK_IDS.SERVICE_FILE);
    expect(fileCheck).toBeDefined();
    // Service is not installed, so should fail
    expect(fileCheck?.status).toBe("fail");
    expect(fileCheck?.fix).toContain("koi deploy");
  });

  it("reports health endpoint as fail when service is not running", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const healthCheck = report.checks.find((c) => c.id === CHECK_IDS.HEALTH_ENDPOINT);
    expect(healthCheck).toBeDefined();
    expect(healthCheck?.status).toBe("fail");
  });

  it("each check has id, name, status, and message", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const allIds = new Set<string>(Object.values(CHECK_IDS));

    for (const check of report.checks) {
      expect(allIds.has(check.id)).toBe(true);
      expect(typeof check.name).toBe("string");
      expect(check.name.length).toBeGreaterThan(0);
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(typeof check.message).toBe("string");
      expect(check.message.length).toBeGreaterThan(0);
    }
  });

  it("failed checks include a fix hint", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const failedChecks = report.checks.filter((c) => c.status === "fail");

    for (const check of failedChecks) {
      expect(check.fix).toBeDefined();
      expect(typeof check.fix).toBe("string");
    }
  });

  it("counts match check statuses", async () => {
    const report = await runDiagnostics(BASE_CONFIG);

    const passByCount = report.checks.filter((c) => c.status === "pass").length;
    const warnByCount = report.checks.filter((c) => c.status === "warn").length;
    const failByCount = report.checks.filter((c) => c.status === "fail").length;

    expect(report.passing).toBe(passByCount);
    expect(report.warnings).toBe(warnByCount);
    expect(report.failures).toBe(failByCount);
  });
});

// ---------------------------------------------------------------------------
// CHECK_IDS
// ---------------------------------------------------------------------------

describe("CHECK_IDS", () => {
  it("typed check IDs match between diagnostic and repair", async () => {
    // Run a real diagnostic to get all check IDs that the system produces
    const report = await runDiagnostics(BASE_CONFIG);
    const reportIds = new Set(report.checks.map((c) => c.id));
    const definedIds = new Set<string>(Object.values(CHECK_IDS));

    // Every ID in the report must be a defined CHECK_ID
    for (const id of reportIds) {
      expect(definedIds.has(id)).toBe(true);
    }
  });

  it("every CHECK_IDS value is a unique string", () => {
    const values = Object.values(CHECK_IDS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
