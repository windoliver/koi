import { describe, expect, test } from "bun:test";
import { createHarnessScheduler } from "../index.js";

describe("@koi/harness-scheduler api surface", () => {
  test("exports createHarnessScheduler", () => {
    expect(createHarnessScheduler).toBeDefined();
    expect(typeof createHarnessScheduler).toBe("function");
  });
});
