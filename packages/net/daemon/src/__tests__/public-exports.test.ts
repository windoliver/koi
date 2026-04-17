import { describe, expect, it } from "bun:test";
import {
  computeBackoff,
  createSubprocessBackend,
  createSupervisor,
  registerSignalHandlers,
} from "../index.js";

describe("@koi/daemon public exports", () => {
  // If the docs advertise a public API, it must be importable from the
  // package root. This smoke test fails CI if any documented export is
  // dropped from the barrel.
  it("exports every documented entry point", () => {
    expect(typeof createSupervisor).toBe("function");
    expect(typeof createSubprocessBackend).toBe("function");
    expect(typeof registerSignalHandlers).toBe("function");
    expect(typeof computeBackoff).toBe("function");
  });
});
