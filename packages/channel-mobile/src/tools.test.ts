import { describe, expect, test } from "bun:test";
import { CAMERA_TOOL, DEFAULT_MOBILE_TOOLS, GPS_TOOL, HAPTIC_TOOL } from "./tools.js";

describe("mobile tool descriptors", () => {
  test("CAMERA_TOOL has required fields", () => {
    expect(CAMERA_TOOL.name).toBe("mobile_camera");
    expect(CAMERA_TOOL.description).toBeTruthy();
    expect(CAMERA_TOOL.inputSchema).toBeDefined();
    expect(CAMERA_TOOL.tags).toContain("mobile");
  });

  test("GPS_TOOL has required fields", () => {
    expect(GPS_TOOL.name).toBe("mobile_gps");
    expect(GPS_TOOL.description).toBeTruthy();
    expect(GPS_TOOL.inputSchema).toBeDefined();
    expect(GPS_TOOL.tags).toContain("mobile");
  });

  test("HAPTIC_TOOL has required fields", () => {
    expect(HAPTIC_TOOL.name).toBe("mobile_haptic");
    expect(HAPTIC_TOOL.description).toBeTruthy();
    expect(HAPTIC_TOOL.inputSchema).toBeDefined();
    expect(HAPTIC_TOOL.tags).toContain("mobile");
  });

  test("DEFAULT_MOBILE_TOOLS includes all built-in tools", () => {
    expect(DEFAULT_MOBILE_TOOLS).toHaveLength(3);
    const names = DEFAULT_MOBILE_TOOLS.map((t) => t.name);
    expect(names).toContain("mobile_camera");
    expect(names).toContain("mobile_gps");
    expect(names).toContain("mobile_haptic");
  });

  test("all tools have unique names", () => {
    const names = DEFAULT_MOBILE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
