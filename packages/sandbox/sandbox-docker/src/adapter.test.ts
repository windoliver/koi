import { describe, expect, test } from "bun:test";
import { createDockerAdapter } from "./adapter.js";
import type { DockerClient } from "./types.js";

const stubClient: DockerClient = {
  createContainer: async () => ({
    id: "c1",
    exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    stop: async () => {},
    remove: async () => {},
  }),
};

describe("createDockerAdapter", () => {
  test("returns a SandboxAdapter named 'docker' when client provided", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("docker");
  });

  test("create(profile) yields a SandboxInstance with working exec", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    const inst = await r.value.create({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: false },
      resources: {},
    });
    const out = await inst.exec("echo", ["ok"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ok");
  });

  // Fail-closed: when no client + probe returns unavailable → ok: false, UNAVAILABLE
  test("returns ok: false with UNAVAILABLE when detectDocker probe fails", async () => {
    const unavailableProbe = async (): Promise<number> => 1;
    const r = await createDockerAdapter({ probe: unavailableProbe });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  // Fail-closed: detectDocker probe throws → ok: false, UNAVAILABLE
  test("returns ok: false with UNAVAILABLE when probe throws", async () => {
    const throwingProbe = async (): Promise<number> => {
      throw new Error("cannot reach docker");
    };
    const r = await createDockerAdapter({ probe: throwingProbe });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  // Slow path: probe succeeds → build adapter with default client
  test("returns ok: true with default client when probe succeeds", async () => {
    const successProbe = async (): Promise<number> => 0;
    const r = await createDockerAdapter({ probe: successProbe });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`Expected ok, got: ${r.error.message}`);
    expect(r.value.name).toBe("docker");
  });

  // Explicit client is preserved (sync path — no probe called)
  test("explicit client skips probe and returns ok: true", async () => {
    // If probe were called, it would fail — but explicit client skips probe.
    const failProbe = async (): Promise<number> => {
      throw new Error("should not be called");
    };
    const r = await createDockerAdapter({ client: stubClient, probe: failProbe });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("Expected ok");
    expect(r.value.name).toBe("docker");
  });

  // Fix 2 (socketPath): when socketPath configured + probe succeeds, adapter is built
  test("builds adapter when socketPath configured and probe succeeds", async () => {
    // Provide a successful probe (probe receives socketPath-aware default probe under the hood,
    // but for this test we use an explicit probe to avoid spawning real docker).
    const successProbe = async (): Promise<number> => 0;
    const r = await createDockerAdapter({
      socketPath: "/custom/docker.sock",
      probe: successProbe,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`Expected ok, got: ${r.error.message}`);
    expect(r.value.name).toBe("docker");
  });

  // Fix 2 (socketPath): when socketPath configured + probe fails, returns UNAVAILABLE
  test("returns UNAVAILABLE when socketPath configured but probe fails", async () => {
    const failProbe = async (): Promise<number> => 1;
    const r = await createDockerAdapter({
      socketPath: "/custom/docker.sock",
      probe: failProbe,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("Expected ok: false");
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  // Fix 2: profile with denyRead → create() rejects with helpful error
  test("create(profile) throws when profile has denyRead (unsupported Docker semantics)", async () => {
    const r = await createDockerAdapter({ client: stubClient });
    if (!r.ok) throw new Error("setup failed");
    const profileWithDenyRead = {
      filesystem: { defaultReadAccess: "open" as const, denyRead: ["/etc"] },
      network: { allow: false },
      resources: {},
    };
    await expect(r.value.create(profileWithDenyRead)).rejects.toThrow("Invalid profile");
  });
});
