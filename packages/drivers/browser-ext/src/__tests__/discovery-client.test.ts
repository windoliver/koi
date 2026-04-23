import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { selectDiscoveryHost } from "../discovery-client.js";
import { writeDiscoveryFile } from "../native-host/discovery.js";

describe("selectDiscoveryHost", () => {
  let dir: string;
  const children: Array<ReturnType<typeof Bun.spawn>> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-browser-ext-driver-discovery-"));
  });

  afterEach(async () => {
    for (const child of children) {
      child.kill();
      await child.exited;
    }
    children.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  async function socketPath(name: string): Promise<string> {
    const path = join("/tmp", `${basename(dir)}-${name}.sock`);
    await writeFile(path, "");
    return path;
  }

  function spawnLivePid(): number {
    const child = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    children.push(child);
    return child.pid;
  }

  test("selects the only live host", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      socket: await socketPath("one"),
      ready: true,
      name: "personal",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });

    const selected = await selectDiscoveryHost({ instancesDir: dir });
    expect("code" in selected).toBe(false);
    if ("code" in selected) {
      return;
    }
    expect(selected.name).toBe("personal");
  });

  test("returns HOST_AMBIGUOUS when multiple live instance groups remain", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      socket: await socketPath("one"),
      ready: true,
      name: "personal",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });
    await writeDiscoveryFile(dir, {
      instanceId: "22222222-2222-2222-2222-222222222222",
      pid: spawnLivePid(),
      socket: await socketPath("two"),
      ready: true,
      name: "work",
      browserHint: "Brave",
      extensionVersion: "0.2.0",
      epoch: 1,
      seq: 1,
    });

    const selected = await selectDiscoveryHost({ instancesDir: dir });
    expect("code" in selected && selected.context?.extensionCode).toBe("HOST_AMBIGUOUS");
  });

  test("keeps only the highest epoch+seq within an instance group", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      socket: await socketPath("old"),
      ready: true,
      name: "personal",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });
    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: spawnLivePid(),
      socket: await socketPath("new"),
      ready: true,
      name: "personal",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.1",
      epoch: 1,
      seq: 2,
    });

    const selected = await selectDiscoveryHost({
      instancesDir: dir,
      select: { instanceId: "11111111-1111-1111-1111-111111111111" },
    });
    expect("code" in selected).toBe(false);
    if ("code" in selected) {
      return;
    }
    expect(selected.seq).toBe(2);
  });

  test("selector narrows by name", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      socket: await socketPath("personal"),
      ready: true,
      name: "personal",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });
    await writeDiscoveryFile(dir, {
      instanceId: "22222222-2222-2222-2222-222222222222",
      pid: spawnLivePid(),
      socket: await socketPath("work"),
      ready: true,
      name: "work",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });

    const selected = await selectDiscoveryHost({ instancesDir: dir, select: { name: "work" } });
    expect("code" in selected).toBe(false);
    if ("code" in selected) {
      return;
    }
    expect(selected.instanceId).toBe("22222222-2222-2222-2222-222222222222");
  });

  test("garbage-collects missing socket files", async () => {
    const missingPath = join(dir, "missing.sock");
    await mkdir(dir, { recursive: true });
    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      socket: missingPath,
      ready: true,
      name: "stale",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });

    const selected = await selectDiscoveryHost({ instancesDir: dir });
    expect("code" in selected && selected.context?.extensionCode).toBe("HOST_SPAWN_FAILED");
  });
});
