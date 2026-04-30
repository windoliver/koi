import { describe, expect, test } from "bun:test";
import * as api from "../index.js";

describe("@koi/eval public API", () => {
  test("exports core runtime functions", () => {
    expect(typeof api.runEval).toBe("function");
    expect(typeof api.exactMatch).toBe("function");
    expect(typeof api.toolCall).toBe("function");
    expect(typeof api.compareRuns).toBe("function");
    expect(typeof api.createFsStore).toBe("function");
    expect(typeof api.runSelfTest).toBe("function");
  });

  test("exposes EVAL_DEFAULTS as readonly constants", () => {
    expect(api.EVAL_DEFAULTS.TIMEOUT_MS).toBe(60_000);
    expect(api.EVAL_DEFAULTS.PASS_THRESHOLD).toBe(0.5);
  });
});
