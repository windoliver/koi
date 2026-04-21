#!/usr/bin/env node
/**
 * Production entrypoint for the Chrome native-messaging host.
 *
 * chrome.runtime.connectNative() launches this binary (via the generated
 * host-wrapper shell script) with stdin/stdout bound to the native-messaging
 * transport. Reads install-layout paths from env vars so the installed
 * wrapper can configure the host without command-line flags — consistent
 * with how Chrome invokes native hosts (no argv for the host).
 *
 * Distinct from `src/__tests__/__integration__/launch-host.mjs` which exists
 * only for test harness fixtures.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { runNativeHost } from "../native-host/index.js";

async function main(): Promise<void> {
  const authDir = process.env.KOI_BE_AUTH ?? join(homedir(), ".koi", "browser-ext");
  const socketPath = process.env.KOI_BE_SOCKET ?? join(authDir, "host.sock");
  const discoveryDir = process.env.KOI_BE_DISCOVERY ?? join(authDir, "instances");
  const quarantineDir = process.env.KOI_BE_QUARANTINE ?? join(authDir, "quarantine");

  const handle = await runNativeHost({
    stdin: process.stdin,
    stdout: process.stdout,
    socketPath,
    discoveryDir,
    quarantineDir,
    authDir,
    name: "koi-browser-ext",
    browserHint: null,
    epoch: 1,
  });

  const shutdown = (): void => {
    handle
      .shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Funnel every non-signal completion through shutdown() too. Several
  // internal failure paths (stdin EOF, watchdog expiry, protocol negotiation
  // failure) resolve waitUntilDone() via `done()` alone; the socket unlink +
  // discovery-file cleanup lives in shutdown(). Exiting directly here would
  // leave stale sockets and discovery records behind and make restart
  // behavior depend on best-effort stale-file reaping.
  await handle.waitUntilDone();
  await handle.shutdown().catch(() => {});
  process.exit(0);
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `koi-browser-ext native host failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
