import { describe, expect, test } from "bun:test";
import type { ForgeError } from "./errors.js";
import {
  governanceError,
  sandboxError,
  selfTestError,
  staticError,
  storeError,
  trustError,
} from "./errors.js";

describe("staticError", () => {
  test("creates error with stage 'static'", () => {
    const err = staticError("INVALID_NAME", "bad name");
    expect(err.stage).toBe("static");
    expect(err.code).toBe("INVALID_NAME");
    expect(err.message).toBe("bad name");
  });
});

describe("sandboxError", () => {
  test("creates error with stage 'sandbox'", () => {
    const err = sandboxError("TIMEOUT", "timed out", 5000);
    expect(err.stage).toBe("sandbox");
    expect(err.code).toBe("TIMEOUT");
    if (err.stage === "sandbox") {
      expect(err.durationMs).toBe(5000);
    }
  });

  test("omits durationMs when undefined", () => {
    const err = sandboxError("CRASH", "crashed");
    expect(err.stage).toBe("sandbox");
    if (err.stage === "sandbox") {
      expect(err.durationMs).toBeUndefined();
    }
  });
});

describe("selfTestError", () => {
  test("creates error with failures", () => {
    const failures = [{ testName: "t1", expected: 1, actual: 2 }];
    const err = selfTestError("TEST_FAILED", "1 failed", failures);
    expect(err.stage).toBe("self_test");
    if (err.stage === "self_test") {
      expect(err.failures).toHaveLength(1);
    }
  });

  test("omits failures when undefined", () => {
    const err = selfTestError("VERIFIER_REJECTED", "rejected");
    if (err.stage === "self_test") {
      expect(err.failures).toBeUndefined();
    }
  });
});

describe("trustError", () => {
  test("creates error with stage 'trust'", () => {
    const err = trustError("GOVERNANCE_REJECTED", "rejected");
    expect(err.stage).toBe("trust");
    expect(err.code).toBe("GOVERNANCE_REJECTED");
  });
});

describe("governanceError", () => {
  test("creates error with stage 'governance'", () => {
    const err = governanceError("FORGE_DISABLED", "disabled");
    expect(err.stage).toBe("governance");
    expect(err.code).toBe("FORGE_DISABLED");
  });
});

describe("storeError", () => {
  test("creates error with stage 'store'", () => {
    const err = storeError("SAVE_FAILED", "disk full");
    expect(err.stage).toBe("store");
    expect(err.code).toBe("SAVE_FAILED");
    expect(err.message).toBe("disk full");
  });

  test("supports all store error codes", () => {
    expect(storeError("LOAD_FAILED", "not found").code).toBe("LOAD_FAILED");
    expect(storeError("SEARCH_FAILED", "error").code).toBe("SEARCH_FAILED");
  });
});

describe("ForgeError discriminant narrowing", () => {
  test("narrows to static variant", () => {
    const err: ForgeError = staticError("INVALID_SCHEMA", "bad schema");
    if (err.stage === "static") {
      expect(err.code).toBe("INVALID_SCHEMA");
    }
  });

  test("narrows to sandbox variant with durationMs", () => {
    const err: ForgeError = sandboxError("OOM", "oom", 3000);
    if (err.stage === "sandbox") {
      expect(err.durationMs).toBe(3000);
    }
  });

  test("narrows to self_test variant with failures", () => {
    const err: ForgeError = selfTestError("TEST_FAILED", "fail", [
      { testName: "t", expected: 1, actual: 2 },
    ]);
    if (err.stage === "self_test") {
      expect(err.failures).toBeDefined();
    }
  });
});
