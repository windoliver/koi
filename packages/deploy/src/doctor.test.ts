import { describe, expect, it } from "bun:test";
import type { DoctorConfig } from "./doctor.js";
import { runDiagnostics } from "./doctor.js";

const BASE_CONFIG: DoctorConfig = {
  agentName: "test-agent",
  system: false,
  port: 19876, // high port unlikely to be in use
};

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
    const bunCheck = report.checks.find((c) => c.name === "Bun runtime");
    expect(bunCheck).toBeDefined();
    // Bun is available since we're running in bun:test
    expect(bunCheck?.status).toBe("pass");
  });

  it("reports service file as fail when not installed", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const fileCheck = report.checks.find((c) => c.name === "Service file");
    expect(fileCheck).toBeDefined();
    // Service is not installed, so should fail
    expect(fileCheck?.status).toBe("fail");
    expect(fileCheck?.fix).toContain("koi deploy");
  });

  it("reports health endpoint as fail when service is not running", async () => {
    const report = await runDiagnostics(BASE_CONFIG);
    const healthCheck = report.checks.find((c) => c.name === "Health endpoint");
    expect(healthCheck).toBeDefined();
    expect(healthCheck?.status).toBe("fail");
  });

  it("each check has name, status, and message", async () => {
    const report = await runDiagnostics(BASE_CONFIG);

    for (const check of report.checks) {
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
