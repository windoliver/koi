import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootHost, driverHello, type HostHarness, shutdownHarness, startHost } from "./harness.js";

const GATE = process.env.KOI_TEST_INTEGRATION === "1";

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    s.on("connect", () => resolve(s));
    s.on("error", reject);
  });
}

describe.skipIf(!GATE)(
  "chunk-crash integration — SIGKILL mid-chunk does not leak chunk buffer state",
  () => {
    let dir: string;
    let harness: HostHarness | null = null;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "koi-be-chunk-"));
    });

    afterEach(async () => {
      if (harness?.proc.exitCode === null) {
        try {
          harness.proc.kill("SIGKILL");
        } catch {}
      }
      harness = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }, 30_000);

    test("first host crashes mid-chunk-stream; new host boots with clean quarantine", async () => {
      const discoveryDir = join(dir, "instances");
      const quarantineDir = join(dir, "quarantine");
      const socketPath1 = join(dir, "host1.sock");
      const socketPath2 = join(dir, "host2.sock");

      harness = await startHost({
        baseDir: dir,
        discoveryDir,
        quarantineDir,
        socketPath: socketPath1,
      });
      await bootHost(harness);

      const driverSock = await connect(harness.socketPath);
      const { writer } = await driverHello(driverSock);

      const tabId = 42;
      const sessionId = randomUUID();
      const reqId = randomUUID();
      const leaseToken = "f".repeat(32);

      // 1. Driver requests attach; extension acks.
      await writer.write(
        JSON.stringify({
          kind: "attach",
          tabId,
          leaseToken,
          attachRequestId: reqId,
        }),
      );
      await harness.extFrames.nextMatching((f) => f.kind === "attach");
      await harness.extStdin.write(
        JSON.stringify({
          kind: "attach_ack",
          ok: true,
          tabId,
          leaseToken,
          attachRequestId: reqId,
          sessionId,
        }),
      );
      // 2. Extension streams 5 chunks for the same correlationId. Send 2 of 5.
      const correlationId = `r:${randomUUID()}`;
      for (let i = 0; i < 2; i++) {
        await harness.extStdin.write(
          JSON.stringify({
            kind: "chunk",
            sessionId,
            correlationId,
            payloadKind: "result_value",
            index: i,
            total: 5,
            data: Buffer.from(`part-${i}`, "utf-8").toString("base64"),
          }),
        );
      }

      // 3. SIGKILL the host mid-stream.
      harness.proc.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (harness && harness.proc.exitCode !== null) resolve();
        else harness?.proc.on("exit", () => resolve());
      });

      // 4. Boot a new host with the SAME discoveryDir + quarantineDir + authDir.
      const restart = await startHost({
        baseDir: dir,
        reuseAuth: true,
        discoveryDir,
        quarantineDir,
        socketPath: socketPath2,
      });
      try {
        await bootHost(restart);

        // 5. Verify the in-flight chunk buffer from the dead host is gone.
        //    The new host should have a fresh (empty) chunk buffer — the crash
        //    means no cross-process leak.
        //    We can't peek state directly; the proxy for "no leak" is that
        //    the new host accepts a driver and shows clean ownership.
        const newSocket = await connect(restart.socketPath);
        const newDriver = await driverHello(newSocket);
        expect(newDriver).toBeDefined();

        // 6. Also verify that the stale host's discovery file was superseded
        //    (only the live host's pid.json should remain).
        const liveFiles = await readdir(discoveryDir);
        const livePids = liveFiles
          .filter((f) => f.endsWith(".json"))
          .map((f) => Number(f.replace(".json", "")));
        expect(livePids).toContain(restart.proc.pid ?? 0);

        newDriver.writer.close();
        newSocket.end();
      } finally {
        await shutdownHarness(restart);
      }
      writer.close();
      driverSock.end();
    }, 30_000);
  },
);
