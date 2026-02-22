import { describe, expect, it } from "bun:test";
import { resolveServiceName } from "./platform.js";

/**
 * Uninstall tests — validates the service name resolution and flow.
 * Actual service manager commands are not invoked.
 */

describe("uninstall flow", () => {
  it("resolves correct service name for uninstall", () => {
    expect(resolveServiceName("my-agent")).toBe("koi-my-agent");
  });

  it("handles special characters in agent name", () => {
    expect(resolveServiceName("Agent With Spaces!")).toBe("koi-agent-with-spaces");
  });

  it("handles empty-ish names gracefully", () => {
    expect(resolveServiceName("---")).toBe("koi-");
  });
});
