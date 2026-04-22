import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootHost, driverHello, type HostHarness, shutdownHarness, startHost } from "./harness.js";

const GATE = process.env.KOI_TEST_INTEGRATION === "1";

describe.skipIf(!GATE)("native-host integration — happy path", () => {
  let dir: string;
  let harness: HostHarness | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-be-happy-"));
  });

  afterEach(async () => {
    if (harness) {
      await shutdownHarness(harness);
      harness = null;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("spawn host → boot sequence → driver hello → bye → clean shutdown", async () => {
    harness = await startHost({ baseDir: dir });
    await bootHost(harness);

    const active = harness;
    const socket: Socket = await new Promise((resolve, reject) => {
      const s = createConnection(active.socketPath);
      s.on("connect", () => resolve(s));
      s.on("error", reject);
    });

    const { writer } = await driverHello(socket);
    await writer.write(JSON.stringify({ kind: "bye" }));
    writer.close();
    socket.end();

    await shutdownHarness(harness);
    harness = null;
    expect(true).toBe(true);
  }, 15_000);
});
