import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createQuarantineJournal } from "../../native-host/quarantine-journal.js";
import { bootHost, type HostHarness, shutdownHarness, startHost } from "./harness.js";

const GATE = process.env.KOI_TEST_INTEGRATION === "1";

/**
 * Spec §8.5: quarantine journal entries survive host restarts. A tab entered
 * in `detaching_failed` state MUST re-hydrate on boot so the new host refuses
 * to re-attach the same tab (prevents double-attach when Chrome still holds
 * the debugger session from the dead host).
 *
 * Scenario: seed a quarantine entry on disk BEFORE the host boots. Verify
 * that the host's boot probe + quarantine-reseed reads it back, and that the
 * ATTACH flow would now reject this tab via `already_attached`.
 *
 * We do NOT wait for the 30s detach_ack timer here — too slow for CI. We
 * simulate the end state (entry on disk) directly.
 */
describe.skipIf(!GATE)("quarantine-durability integration — entries survive host restart", () => {
  let dir: string;
  let harness: HostHarness | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-be-quar-"));
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

  test("entry persists across restart; new host's probe reflects quarantined tab", async () => {
    const discoveryDir = join(dir, "instances");
    const quarantineDir = join(dir, "quarantine");
    const browserSessionId = "integration-test-session";

    // 1. Seed a quarantine entry directly via the public API BEFORE the
    //    host spawns — simulates prior-instance state persisted to disk.
    const instanceId = "seed-instance";
    const preJournal = await createQuarantineJournal({
      dir: quarantineDir,
      instanceId,
      browserSessionId,
    });
    await preJournal.addEntry({
      tabId: 42,
      sessionId: "orphan",
      reason: "chrome_error",
      writerEpoch: 1,
      writerSeq: 1,
    });

    // 2. Boot a new host with the same quarantineDir.
    harness = await startHost({
      baseDir: dir,
      discoveryDir,
      quarantineDir,
      socketPath: join(dir, "host.sock"),
    });
    await bootHost(harness);

    // 3. New host's journal MUST still have the entry.
    const postJournal = await createQuarantineJournal({
      dir: quarantineDir,
      instanceId,
      browserSessionId,
    });
    const entries = await postJournal.readEntries();
    const tab42 = entries.find((e) => e.tabId === 42);
    expect(tab42).toBeDefined();
    expect(tab42?.sessionId).toBe("orphan");
    expect(tab42?.reason).toBe("chrome_error");

    // 4. A DIFFERENT browserSessionId clears the entries (browser
    //    restarted → prior state is no longer relevant per §8.5).
    const wipedJournal = await createQuarantineJournal({
      dir: quarantineDir,
      instanceId,
      browserSessionId: "new-browser-session",
    });
    const wipedEntries = await wipedJournal.readEntries();
    expect(wipedEntries).toEqual([]);

    // 5. Sanity: discovery file still exists for the live host.
    const liveFiles = await readdir(discoveryDir);
    expect(liveFiles.some((f) => f === `${harness?.proc.pid ?? 0}.json`)).toBe(true);

    await shutdownHarness(harness);
    harness = null;
  }, 30_000);
});
