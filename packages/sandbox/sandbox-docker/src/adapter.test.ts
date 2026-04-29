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
  test("returns a SandboxAdapter named 'docker'", () => {
    const r = createDockerAdapter({ client: stubClient });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("docker");
  });

  test("create(profile) yields a SandboxInstance with working exec", async () => {
    const r = createDockerAdapter({ client: stubClient });
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

  test("missing client returns UNAVAILABLE", () => {
    const r = createDockerAdapter({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNAVAILABLE");
  });
});
