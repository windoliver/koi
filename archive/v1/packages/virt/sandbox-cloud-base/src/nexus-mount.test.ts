import { describe, expect, mock, test } from "bun:test";
import type { NexusFuseMount, SandboxAdapterResult, SandboxInstance } from "@koi/core";
import { mountNexusFuse } from "./nexus-mount.js";

function ok(stdout = ""): SandboxAdapterResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, oomKilled: false };
}

function fail(stderr: string): SandboxAdapterResult {
  return { exitCode: 1, stdout: "", stderr, durationMs: 1, timedOut: false, oomKilled: false };
}

function createMockInstance(): SandboxInstance {
  return {
    exec: mock(() => Promise.resolve(ok())),
    readFile: mock(() => Promise.resolve(new Uint8Array())),
    writeFile: mock(() => Promise.resolve()),
    destroy: mock(() => Promise.resolve()),
  };
}

const MOUNT: NexusFuseMount = {
  nexusUrl: "https://nexus.example.com",
  apiKey: "secret-key",
  mountPath: "/mnt/nexus",
};

describe("mountNexusFuse", () => {
  test("execs mkdir, nexus-fuse, and ls in order for each mount", async () => {
    const instance = createMockInstance();
    const calls: string[] = [];
    (instance.exec as ReturnType<typeof mock>).mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(ok());
    });

    await mountNexusFuse(instance, [MOUNT]);

    expect(calls).toEqual(["mkdir", "nexus-fuse", "ls"]);
    expect(instance.exec).toHaveBeenCalledTimes(3);
  });

  test("passes correct args to nexus-fuse", async () => {
    const instance = createMockInstance();
    await mountNexusFuse(instance, [MOUNT]);

    const execMock = instance.exec as ReturnType<typeof mock>;
    const nexusFuseCall = execMock.mock.calls[1];
    expect(nexusFuseCall?.[0]).toBe("nexus-fuse");
    expect(nexusFuseCall?.[1]).toEqual([
      "mount",
      "/mnt/nexus",
      "--url",
      "https://nexus.example.com",
      "--api-key",
      "secret-key",
    ]);
  });

  test("passes --agent-id when configured", async () => {
    const instance = createMockInstance();
    const mountWithAgent: NexusFuseMount = { ...MOUNT, agentId: "agent-42" };
    await mountNexusFuse(instance, [mountWithAgent]);

    const execMock = instance.exec as ReturnType<typeof mock>;
    const nexusFuseCall = execMock.mock.calls[1];
    expect(nexusFuseCall?.[1]).toEqual([
      "mount",
      "/mnt/nexus",
      "--url",
      "https://nexus.example.com",
      "--api-key",
      "secret-key",
      "--agent-id",
      "agent-42",
    ]);
  });

  test("throws on non-zero exit from nexus-fuse", async () => {
    const instance = createMockInstance();
    let callCount = 0;
    (instance.exec as ReturnType<typeof mock>).mockImplementation(() => {
      callCount += 1;
      // mkdir succeeds, nexus-fuse fails
      return Promise.resolve(callCount === 2 ? fail("mount error") : ok());
    });

    await expect(mountNexusFuse(instance, [MOUNT])).rejects.toThrow(
      "nexus-fuse mount failed for /mnt/nexus: mount error",
    );
  });

  test("throws on failed mkdir", async () => {
    const instance = createMockInstance();
    (instance.exec as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(fail("permission denied")),
    );

    await expect(mountNexusFuse(instance, [MOUNT])).rejects.toThrow(
      "Failed to create mount point /mnt/nexus: permission denied",
    );
  });

  test("throws on failed verification (ls fails)", async () => {
    const instance = createMockInstance();
    let callCount = 0;
    (instance.exec as ReturnType<typeof mock>).mockImplementation(() => {
      callCount += 1;
      // mkdir and nexus-fuse succeed, ls fails
      return Promise.resolve(callCount === 3 ? fail("transport endpoint not connected") : ok());
    });

    await expect(mountNexusFuse(instance, [MOUNT])).rejects.toThrow(
      "Nexus FUSE mount verification failed for /mnt/nexus: transport endpoint not connected",
    );
  });

  test("throws on relative mount path", async () => {
    const instance = createMockInstance();
    const bad: NexusFuseMount = { ...MOUNT, mountPath: "relative/path" };
    await expect(mountNexusFuse(instance, [bad])).rejects.toThrow("must be absolute");
  });

  test("throws on mount path with ..", async () => {
    const instance = createMockInstance();
    const bad: NexusFuseMount = { ...MOUNT, mountPath: "/mnt/../etc/shadow" };
    await expect(mountNexusFuse(instance, [bad])).rejects.toThrow('must not contain ".."');
  });

  test("throws on empty nexusUrl", async () => {
    const instance = createMockInstance();
    const bad: NexusFuseMount = { ...MOUNT, nexusUrl: "" };
    await expect(mountNexusFuse(instance, [bad])).rejects.toThrow("nexusUrl must not be empty");
  });

  test("throws on empty apiKey", async () => {
    const instance = createMockInstance();
    const bad: NexusFuseMount = { ...MOUNT, apiKey: "" };
    await expect(mountNexusFuse(instance, [bad])).rejects.toThrow("apiKey must not be empty");
  });

  test("throws on empty mount path", async () => {
    const instance = createMockInstance();
    const bad: NexusFuseMount = { ...MOUNT, mountPath: "" };
    await expect(mountNexusFuse(instance, [bad])).rejects.toThrow("must be absolute");
  });

  test("no-ops on empty array", async () => {
    const instance = createMockInstance();
    await mountNexusFuse(instance, []);
    expect(instance.exec).not.toHaveBeenCalled();
  });

  test("mounts multiple in sequence", async () => {
    const instance = createMockInstance();
    const calls: string[] = [];
    (instance.exec as ReturnType<typeof mock>).mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(ok());
    });

    const mount2: NexusFuseMount = {
      nexusUrl: "https://nexus2.example.com",
      apiKey: "key-2",
      mountPath: "/mnt/nexus2",
    };

    await mountNexusFuse(instance, [MOUNT, mount2]);

    expect(calls).toEqual(["mkdir", "nexus-fuse", "ls", "mkdir", "nexus-fuse", "ls"]);
  });
});
