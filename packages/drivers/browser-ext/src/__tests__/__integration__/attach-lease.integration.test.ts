import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootHost,
  driverHello,
  type FrameQueue,
  type HostHarness,
  shutdownHarness,
  startHost,
} from "./harness.js";

const GATE = process.env.KOI_TEST_INTEGRATION === "1";

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    s.on("connect", () => resolve(s));
    s.on("error", reject);
  });
}

describe.skipIf(!GATE)("attach-lease integration — two drivers racing for same tab", () => {
  let dir: string;
  let harness: HostHarness | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-be-lease-"));
  });

  afterEach(async () => {
    if (harness) {
      await shutdownHarness(harness);
      harness = null;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("first attach wins; second gets already_attached; after detach second retries and wins", async () => {
    harness = await startHost({ baseDir: dir });
    await bootHost(harness);

    const socketA = await connect(harness.socketPath);
    const socketB = await connect(harness.socketPath);
    const a = await driverHello(socketA);
    const b = await driverHello(socketB);

    const tabId = 42;
    const reqA = randomUUID();
    const reqB = randomUUID();
    const leaseA = "a".repeat(32);
    const leaseB = "b".repeat(32);
    const sessionId = randomUUID();

    // clientA fires attach first — host forwards it to extension via NM.
    await a.writer.write(
      JSON.stringify({
        kind: "attach",
        tabId,
        leaseToken: leaseA,
        attachRequestId: reqA,
      }),
    );

    // Extension (us) sees the NM attach frame; ack success for the FIRST attach.
    const nm = harness.extFrames;
    const nmAttachA = await nm.nextMatching((f) => f.kind === "attach");
    expect((nmAttachA as { attachRequestId: string }).attachRequestId).toBe(reqA);
    await harness.extStdin.write(
      JSON.stringify({
        kind: "attach_ack",
        ok: true,
        tabId,
        leaseToken: leaseA,
        attachRequestId: reqA,
        sessionId,
      }),
    );

    const ackA = await a.reader.nextMatching((f) => f.kind === "attach_ack");
    expect((ackA as { ok: boolean; sessionId: string }).ok).toBe(true);

    // clientB fires attach on the same tab — host should SHORT-CIRCUIT with
    // already_attached (no NM forward). Set a short timeout on nm.next to
    // prove no attach frame hits the extension.
    await b.writer.write(
      JSON.stringify({
        kind: "attach",
        tabId,
        leaseToken: leaseB,
        attachRequestId: reqB,
      }),
    );
    const ackB = await b.reader.nextMatching((f) => f.kind === "attach_ack");
    expect((ackB as { ok: boolean; reason?: string }).ok).toBe(false);
    expect((ackB as { reason?: string }).reason).toBe("already_attached");

    // clientA disconnects → host initiates detach. Ack it.
    socketA.end();
    const nmDetach = await nm.nextMatching((f) => f.kind === "detach");
    await harness.extStdin.write(
      JSON.stringify({
        kind: "detach_ack",
        sessionId: (nmDetach as { sessionId: string }).sessionId,
        tabId,
        ok: true,
      }),
    );

    // Give the host a beat to clear ownership.
    await new Promise((r) => setTimeout(r, 100));

    // clientB retries — now it should forward to extension.
    const reqB2 = randomUUID();
    await b.writer.write(
      JSON.stringify({
        kind: "attach",
        tabId,
        leaseToken: leaseB,
        attachRequestId: reqB2,
      }),
    );
    const nmAttachB = await nm.nextMatching((f) => f.kind === "attach");
    expect((nmAttachB as { attachRequestId: string }).attachRequestId).toBe(reqB2);
    const newSession = randomUUID();
    await harness.extStdin.write(
      JSON.stringify({
        kind: "attach_ack",
        ok: true,
        tabId,
        leaseToken: leaseB,
        attachRequestId: reqB2,
        sessionId: newSession,
      }),
    );
    const ackB2 = await b.reader.nextMatching((f) => f.kind === "attach_ack");
    expect((ackB2 as { ok: boolean; sessionId: string }).ok).toBe(true);
    expect((ackB2 as { sessionId: string }).sessionId).toBe(newSession);

    b.writer.close();
    socketB.end();
    void ({} as FrameQueue);
  }, 20_000);
});
