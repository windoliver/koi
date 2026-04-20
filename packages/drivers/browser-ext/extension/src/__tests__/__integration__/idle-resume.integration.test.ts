import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Spec §8.4: The MV3 service worker keeps itself alive via `chrome.alarms`
 * (every 30s) and NM port ping/pong while connected. Chromium kills inactive
 * MV3 service workers after 30s of no activity.
 *
 * This test launches real Chromium with our extension loaded, idles past the
 * 30-second mark, and verifies the service worker is still reachable (proving
 * the alarms-based keepalive worked).
 *
 * Gated behind KOI_TEST_EXTENSION_E2E=1. Idle duration defaults to 35s
 * (just past Chrome's kill threshold); set KOI_TEST_SLOW=1 for the full 90s
 * variant.
 */
const runE2E = process.env.KOI_TEST_EXTENSION_E2E === "1";
const IDLE_MS = process.env.KOI_TEST_SLOW === "1" ? 90_000 : 35_000;

const EXT_ROOT = resolve(import.meta.dir, "../../..");
const DIST_EXT = join(EXT_ROOT, "dist", "extension");

describe.skipIf(!runE2E)("MV3 service-worker idle-resume integration (real Chromium)", () => {
  let userDataDir: string;

  beforeAll(() => {
    spawnSync("bun", ["run", "build:extension"], {
      cwd: resolve(EXT_ROOT, ".."),
      stdio: "inherit",
    });
  });

  afterEach(async () => {
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test(
    `service worker survives ${IDLE_MS / 1000}s idle (alarms keepalive keeps it reachable)`,
    async () => {
      const { chromium } = await import("playwright");

      userDataDir = await mkdtemp(join(tmpdir(), "koi-ext-idle-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${DIST_EXT}`, `--load-extension=${DIST_EXT}`],
      });

      try {
        type Worker = import("playwright").Worker;
        const findWorker = (): Worker | undefined =>
          context.serviceWorkers().find((w) => w.url().endsWith("service-worker.js"));

        // Force first-run SW boot via a blank page navigation.
        const page = await context.newPage();
        await page.goto("about:blank").catch(() => {});

        let firstWorker = findWorker();
        if (!firstWorker) {
          try {
            firstWorker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
          } catch {
            firstWorker = findWorker();
          }
        }
        expect(firstWorker).toBeDefined();

        await new Promise((r) => setTimeout(r, IDLE_MS));

        const afterIdle = findWorker();
        expect(afterIdle).toBeDefined();
      } finally {
        await context.close();
      }
    },
    IDLE_MS + 30_000,
  );
});
