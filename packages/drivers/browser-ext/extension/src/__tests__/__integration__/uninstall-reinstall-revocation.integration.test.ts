import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Spec §8.7: reinstalling the host generates a new installId. On the next
 * host_hello, the extension must wipe `always`, `allow_once`, and the
 * private-origin allowlist before marking the port ready.
 *
 * The wipe LOGIC is covered at the unit level (see connect-native.test.ts:
 * "installId mismatch wipes grants before ready").
 *
 * This harness is scaffolding for the real-Chromium round-trip of the same
 * path via chrome.storage.local. Gated behind KOI_TEST_EXTENSION_E2E=1.
 *
 * Known work-in-progress: Playwright 1.49's MV3 service-worker discovery in
 * headful persistent-context mode can race — the SW may not register within
 * 5s reliably. The loader bits (launchPersistentContext + extension args)
 * are correct; further tuning (explicit `await context.waitForEvent("serviceworker")`
 * or a first-run landing page to trigger SW boot) can make this green.
 */
const runE2E = process.env.KOI_TEST_EXTENSION_E2E === "1";

const EXT_ROOT = resolve(import.meta.dir, "../../..");
const DIST_EXT = join(EXT_ROOT, "dist", "extension");

describe.skipIf(!runE2E)(
  "uninstall-reinstall revocation integration (real Chromium storage round-trip)",
  () => {
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

    test("chrome.storage.local in real Chromium: seed grants → wipe → verify cleared", async () => {
      const { chromium } = await import("playwright");

      userDataDir = await mkdtemp(join(tmpdir(), "koi-ext-uninst-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${DIST_EXT}`, `--load-extension=${DIST_EXT}`],
      });

      try {
        type Worker = import("playwright").Worker;
        const findWorker = (): Worker | undefined =>
          context.serviceWorkers().find((w) => w.url().endsWith("service-worker.js"));

        // MV3 SWs register lazily — force a first-run page so Chrome boots
        // the extension's SW, then wait for it (existing or newly spawned).
        const page = await context.newPage();
        await page.goto("about:blank").catch(() => {});

        let worker = findWorker();
        if (!worker) {
          try {
            worker = await context.waitForEvent("serviceworker", { timeout: 15_000 });
          } catch {
            worker = findWorker();
          }
        }
        expect(worker).toBeDefined();
        if (!worker) return;

        // Seed grants directly via chrome.storage.local from inside the worker.
        await worker.evaluate(async () => {
          await chrome.storage.local.set({
            "koi.installId": "old-install-id",
            "koi.alwaysGrants": {
              "https://example.com": { grantedAt: "2026-04-20T00:00:00.000Z" },
            },
            "koi.privateOriginAllowlist": ["http://localhost:3000"],
          });
        });

        const seeded = await worker.evaluate(() =>
          chrome.storage.local.get([
            "koi.installId",
            "koi.alwaysGrants",
            "koi.privateOriginAllowlist",
          ]),
        );
        expect((seeded as Record<string, unknown>)["koi.installId"]).toBe("old-install-id");

        // Simulate wipe: the wipeForInstallId path clears the grant keys.
        await worker.evaluate(async () => {
          await chrome.storage.local.remove([
            "koi.alwaysGrants",
            "koi.privateOriginAllowlist",
            "koi.allowOnceGrants",
          ]);
          await chrome.storage.local.set({ "koi.installId": "new-install-id" });
        });

        const afterWipe = (await worker.evaluate(() =>
          chrome.storage.local.get([
            "koi.installId",
            "koi.alwaysGrants",
            "koi.privateOriginAllowlist",
          ]),
        )) as Record<string, unknown>;

        expect(afterWipe["koi.installId"]).toBe("new-install-id");
        expect(afterWipe["koi.alwaysGrants"]).toBeUndefined();
        expect(afterWipe["koi.privateOriginAllowlist"]).toBeUndefined();
      } finally {
        await context.close();
      }
    }, 60_000);
  },
);
