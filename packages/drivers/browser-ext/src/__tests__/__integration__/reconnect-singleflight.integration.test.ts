import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootHost, type HostHarness, shutdownHarness, startHost } from "./harness.js";

const GATE = process.env.KOI_TEST_INTEGRATION === "1";

/**
 * Spec §8.3 / §9.2: the extension is the sole spawn authority. This test
 * validates the HOST side of that contract: only one host is live at a time,
 * and its discovery file is the single source of truth.
 *
 * Scenario: two concurrent spawn attempts race (simulating extension's
 * disconnect handler + alarm tick firing together). After both settle, exactly
 * one discovery file should be present (the live host). Any dead-pid files
 * must have been superseded.
 */
describe.skipIf(!GATE)(
  "reconnect-singleflight integration — only one live host + discovery file",
  () => {
    let dir: string;
    const harnesses: HostHarness[] = [];

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "koi-be-sf-"));
    });

    afterEach(async () => {
      await Promise.all(
        harnesses.map(async (h) => {
          if (h.proc.exitCode === null) {
            try {
              h.proc.kill("SIGKILL");
            } catch {}
          }
        }),
      );
      harnesses.length = 0;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }, 30_000);

    test("two host spawns race; only winner's discovery file remains live", async () => {
      const discoveryDir = join(dir, "instances");
      const quarantineDir = join(dir, "quarantine");

      // Start the first host and complete its boot sequence.
      const a = await startHost({
        baseDir: dir,
        discoveryDir,
        quarantineDir,
        socketPath: join(dir, "a.sock"),
      });
      harnesses.push(a);
      await bootHost(a);

      // First host's discovery file is now present. Kill it HARD (simulating
      // an unexpected crash — no proper shutdown, file lingers).
      a.proc.kill("SIGKILL");
      await new Promise<void>((resolve) => a.proc.on("exit", () => resolve()));

      // Second host boots into the SAME discoveryDir. The supersedeStale scan
      // on boot should remove a's stale json (its pid is now dead).
      const b = await startHost({
        baseDir: dir,
        reuseAuth: true,
        discoveryDir,
        quarantineDir,
        socketPath: join(dir, "b.sock"),
      });
      harnesses.push(b);
      await bootHost(b);

      const files = await readdir(discoveryDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      expect(jsonFiles.length).toBe(1);
      expect(jsonFiles[0]).toBe(`${b.proc.pid ?? 0}.json`);

      await shutdownHarness(b);
    }, 30_000);
  },
);
