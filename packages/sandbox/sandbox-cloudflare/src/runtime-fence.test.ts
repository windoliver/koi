import { describe, expect, it } from "bun:test";

import { RUNTIME_FENCE_FUNCTION_NAME, RUNTIME_FENCE_PREAMBLE_SOURCE } from "./runtime-fence.js";

describe("RUNTIME_FENCE_PREAMBLE_SOURCE", () => {
  it("declares and self-invokes the install function", () => {
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain(`var ${RUNTIME_FENCE_FUNCTION_NAME}`);
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain(`${RUNTIME_FENCE_FUNCTION_NAME}();`);
  });

  it("installs a throwing accessor for `fetch`", () => {
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('Object.defineProperty(globalThis, "fetch"');
  });

  it("installs a throwing accessor for `caches`", () => {
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('Object.defineProperty(globalThis, "caches"');
  });

  it("each accessor throws with a RUNTIME_FENCE prefix in its message", () => {
    // The literal string assembly that becomes the error message is present in the preamble.
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('throw new Error("RUNTIME_FENCE: globalThis."');
  });

  it("is idempotent — re-invoking the function is a no-op (installed-flag check)", () => {
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain("if (installed) return;");
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain("installed = true;");
  });

  it("installs throwing accessors on parent objects for member-chain targets", () => {
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('"WebAssembly"');
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('"instantiate"');
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('"navigator"');
    expect(RUNTIME_FENCE_PREAMBLE_SOURCE).toContain('"sendBeacon"');
  });

  it("evaluates without syntax errors as a JS source string", () => {
    // Wrap in a function so identifier capture doesn't pollute the test environment.
    expect(() => {
      new Function(`${RUNTIME_FENCE_PREAMBLE_SOURCE}; return true;`);
    }).not.toThrow();
  });
});
