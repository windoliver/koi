import { describe, expect, test } from "bun:test";
import { computeMutationPressure } from "./mutation-pressure.js";

describe("computeMutationPressure", () => {
  // --- Default thresholds: frozen > 0.9, stable >= 0.5, experimental >= 0.2 ---

  test("returns frozen for fitness above 0.9", () => {
    expect(computeMutationPressure(0.95)).toBe("frozen");
    expect(computeMutationPressure(1.0)).toBe("frozen");
  });

  test("returns stable for fitness at frozen boundary (0.9 exactly)", () => {
    expect(computeMutationPressure(0.9)).toBe("stable");
  });

  test("returns stable for fitness between 0.5 and 0.9", () => {
    expect(computeMutationPressure(0.7)).toBe("stable");
    expect(computeMutationPressure(0.5)).toBe("stable");
  });

  test("returns experimental for fitness between 0.2 and 0.5", () => {
    expect(computeMutationPressure(0.3)).toBe("experimental");
    expect(computeMutationPressure(0.2)).toBe("experimental");
  });

  test("returns experimental at stable boundary (0.5 exactly)", () => {
    // 0.5 >= 0.5 → stable
    expect(computeMutationPressure(0.5)).toBe("stable");
  });

  test("returns aggressive for fitness below 0.2", () => {
    expect(computeMutationPressure(0.19)).toBe("aggressive");
    expect(computeMutationPressure(0.1)).toBe("aggressive");
    expect(computeMutationPressure(0.0)).toBe("aggressive");
  });

  // --- Edge cases ---

  test("returns aggressive for zero fitness", () => {
    expect(computeMutationPressure(0)).toBe("aggressive");
  });

  test("returns frozen for fitness of 1.0", () => {
    expect(computeMutationPressure(1.0)).toBe("frozen");
  });

  // --- Custom policy ---

  test("uses custom frozen threshold", () => {
    expect(computeMutationPressure(0.85, { frozenThreshold: 0.8 })).toBe("frozen");
    expect(computeMutationPressure(0.8, { frozenThreshold: 0.8 })).toBe("stable");
  });

  test("uses custom stable threshold", () => {
    expect(computeMutationPressure(0.4, { stableThreshold: 0.4 })).toBe("stable");
    expect(computeMutationPressure(0.39, { stableThreshold: 0.4 })).toBe("experimental");
  });

  test("uses custom experimental threshold", () => {
    expect(computeMutationPressure(0.15, { experimentalThreshold: 0.1 })).toBe("experimental");
    expect(computeMutationPressure(0.09, { experimentalThreshold: 0.1 })).toBe("aggressive");
  });

  test("uses fully custom policy", () => {
    const policy = { frozenThreshold: 0.95, stableThreshold: 0.7, experimentalThreshold: 0.3 };
    expect(computeMutationPressure(0.96, policy)).toBe("frozen");
    expect(computeMutationPressure(0.95, policy)).toBe("stable");
    expect(computeMutationPressure(0.7, policy)).toBe("stable");
    expect(computeMutationPressure(0.5, policy)).toBe("experimental");
    expect(computeMutationPressure(0.3, policy)).toBe("experimental");
    expect(computeMutationPressure(0.29, policy)).toBe("aggressive");
  });
});
