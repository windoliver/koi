import { describe, expect, test } from "bun:test";
import { resolveDockerNetwork } from "./network.js";

describe("resolveDockerNetwork", () => {
  test("network.allow=false → networkMode 'none'", () => {
    const r = resolveDockerNetwork({ allow: false });
    expect(r.networkMode).toBe("none");
  });

  test("network.allow=true → networkMode 'bridge'", () => {
    const r = resolveDockerNetwork({ allow: true });
    expect(r.networkMode).toBe("bridge");
  });

  test("undefined network defaults to denied", () => {
    const r = resolveDockerNetwork(undefined);
    expect(r.networkMode).toBe("none");
  });
});
