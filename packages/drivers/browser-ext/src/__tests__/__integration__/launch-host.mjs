#!/usr/bin/env node
// Minimal Node-runnable entry point for integration tests. Spawns runNativeHost
// on process.stdin/stdout, reading paths + metadata from env vars so each test
// can isolate its filesystem state in a tmpdir.

import { runNativeHost } from "../../../dist/native-host/index.js";

const cfg = {
  stdin: process.stdin,
  stdout: process.stdout,
  socketPath: process.env.KOI_BE_SOCKET,
  discoveryDir: process.env.KOI_BE_DISCOVERY,
  quarantineDir: process.env.KOI_BE_QUARANTINE,
  authDir: process.env.KOI_BE_AUTH,
  name: "koi-browser-ext",
  browserHint: null,
  epoch: 1,
};

if (!cfg.socketPath || !cfg.discoveryDir || !cfg.quarantineDir || !cfg.authDir) {
  process.stderr.write("launch-host: KOI_BE_SOCKET/DISCOVERY/QUARANTINE/AUTH env vars required\n");
  process.exit(2);
}

try {
  const handle = await runNativeHost(cfg);
  process.on("SIGTERM", () => {
    handle.shutdown().finally(() => process.exit(0));
  });
  await handle.waitUntilDone();
  process.exit(0);
} catch (err) {
  process.stderr.write(`launch-host: runNativeHost failed: ${err}\n`);
  process.exit(1);
}
