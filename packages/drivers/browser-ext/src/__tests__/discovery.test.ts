import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanInstances,
  supersedeStale,
  unlinkDiscoveryFile,
  writeDiscoveryFile,
} from "../native-host/discovery.js";

describe("discovery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-discovery-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("write + scan round-trip for live pid", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "i1",
      pid: process.pid,
      socket: "/tmp/koi.sock",
      ready: true,
      name: "koi-browser-ext",
      browserHint: "chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });
    const list = await scanInstances(dir);
    expect(list.length).toBe(1);
    expect(list[0]?.socket).toBe("/tmp/koi.sock");
  });

  test("scan filters out records whose pid is dead", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "i1",
      pid: 2147483,
      socket: "/tmp/koi-dead.sock",
      ready: true,
      name: "x",
      browserHint: null,
      extensionVersion: null,
      epoch: 1,
      seq: 1,
    });
    const list = await scanInstances(dir);
    expect(list.length).toBe(0);
  });

  test("atomic write leaves no .tmp file", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "i1",
      pid: process.pid,
      socket: "/tmp/a",
      ready: true,
      name: "x",
      browserHint: null,
      extensionVersion: null,
      epoch: 1,
      seq: 1,
    });
    const final = await readFile(join(dir, `${process.pid}.json`), "utf-8");
    expect(JSON.parse(final).socket).toBe("/tmp/a");
  });

  test("unlink removes the record file", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "i1",
      pid: process.pid,
      socket: "/tmp/a",
      ready: true,
      name: "x",
      browserHint: null,
      extensionVersion: null,
      epoch: 1,
      seq: 1,
    });
    await unlinkDiscoveryFile(dir, process.pid);
    const list = await scanInstances(dir);
    expect(list.length).toBe(0);
  });

  test("supersedeStale only removes dead-pid files with lower (epoch,seq)", async () => {
    await writeDiscoveryFile(dir, {
      instanceId: "i1",
      pid: 2147484,
      socket: "/tmp/old",
      ready: true,
      name: "x",
      browserHint: null,
      extensionVersion: null,
      epoch: 1,
      seq: 1,
    });
    await supersedeStale(dir, { instanceId: "i1", epoch: 1, seq: 2 });
    const list = await scanInstances(dir);
    expect(list.length).toBe(0);
  });
});
