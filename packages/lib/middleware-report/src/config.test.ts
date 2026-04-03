import { describe, expect, it } from "bun:test";

import { validateReportConfig } from "./config.js";

describe("validateReportConfig", () => {
  it("accepts empty config", () => {
    const result = validateReportConfig({});
    expect(result.ok).toBe(true);
  });

  it("accepts config with maxActions", () => {
    const result = validateReportConfig({ maxActions: 100 });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateReportConfig(null);
    expect(result.ok).toBe(false);
  });

  it("rejects undefined", () => {
    const result = validateReportConfig(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object", () => {
    const result = validateReportConfig("string");
    expect(result.ok).toBe(false);
  });

  it("rejects maxActions <= 0", () => {
    const result = validateReportConfig({ maxActions: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects negative maxActions", () => {
    const result = validateReportConfig({ maxActions: -5 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-number maxActions", () => {
    const result = validateReportConfig({ maxActions: "ten" });
    expect(result.ok).toBe(false);
  });

  it("accepts config with maxReports", () => {
    const result = validateReportConfig({ maxReports: 50 });
    expect(result.ok).toBe(true);
  });

  it("rejects maxReports <= 0", () => {
    const result = validateReportConfig({ maxReports: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects negative maxReports", () => {
    const result = validateReportConfig({ maxReports: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-number maxReports", () => {
    const result = validateReportConfig({ maxReports: "ten" });
    expect(result.ok).toBe(false);
  });

  it("rejects fractional maxActions", () => {
    const result = validateReportConfig({ maxActions: 1.5 });
    expect(result.ok).toBe(false);
  });

  it("rejects fractional maxReports", () => {
    const result = validateReportConfig({ maxReports: 2.7 });
    expect(result.ok).toBe(false);
  });
});
