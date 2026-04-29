import { describe, expect, spyOn, test } from "bun:test";
import { detectDocker } from "./detect.js";

describe("detectDocker", () => {
  test("returns available=false when probe returns non-zero", async () => {
    const result = await detectDocker({ probe: async () => 1 });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("docker");
  });

  test("returns available=true when probe exits 0", async () => {
    const result = await detectDocker({ probe: async () => 0 });
    expect(result.available).toBe(true);
  });

  test("returns available=false when probe throws", async () => {
    const result = await detectDocker({
      probe: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("docker probe failed");
  });

  test("default probe spawns docker version and reports availability from exit code", async () => {
    const fakeProc = { exited: Promise.resolve(0) };
    // @ts-expect-error — test stub: Bun.spawn returns a partial subprocess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc);
    try {
      const result = await detectDocker();
      expect(result.available).toBe(true);
      expect(spawnSpy).toHaveBeenCalled();
      const args = spawnSpy.mock.calls[0]?.[0];
      expect(Array.isArray(args) && args[0]).toBe("docker");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 2 (socketPath): default probe passes DOCKER_HOST env when socketPath given
  test("default probe sets DOCKER_HOST in env when socketPath is provided", async () => {
    const fakeProc = { exited: Promise.resolve(0) };
    // @ts-expect-error — test stub: Bun.spawn returns a partial subprocess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeProc);
    try {
      const result = await detectDocker({ socketPath: "/var/run/docker.sock" });
      expect(result.available).toBe(true);
      // Inspect the opts (second arg) from the spawn call to verify DOCKER_HOST was set.
      const opts = spawnSpy.mock.calls[0]?.[1] as { env?: Record<string, string> } | undefined;
      expect(opts?.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
