/**
 * Race worker: invoked by race-runner.ts as a child process. Performs ONE
 * adapter action against the file-backed registry living at
 * KOI_SANDBOX_DOCKER_STATE_DIR. Exit code 0 = success, non-zero + stderr =
 * failure.
 */

import { createDockerAdapter } from "../src/index.js";

const [, , action, scope, delayMsRaw] = process.argv;
const delayMs = Number(delayMsRaw ?? "0");
const tag = process.env.KOI_RACE_TAG ?? "?";

if (action === undefined || scope === undefined) {
  console.error("Usage: race-worker.ts <action> <scope> <delayMs>");
  process.exit(2);
}

const PROFILE = {
  filesystem: { defaultReadAccess: "open" as const },
  network: { allow: false },
  resources: {},
};
const PROFILE_NETWORK = {
  ...PROFILE,
  network: { allow: true },
};

if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

const r = await createDockerAdapter({ image: "alpine:3.20" });
if (!r.ok) {
  console.error(`[${tag}] adapter init failed: ${r.error.message}`);
  process.exit(1);
}
const adapter = r.value;

try {
  if (action === "findOrCreate") {
    if (adapter.findOrCreate === undefined) throw new Error("findOrCreate missing");
    const inst = await adapter.findOrCreate(scope, PROFILE);
    const out = await inst.exec("echo", [`hello-from-${tag}`]);
    console.log(`[${tag}] findOrCreate ok: ${out.stdout.trim()}`);
  } else if (action === "findOrCreate-network") {
    if (adapter.findOrCreate === undefined) throw new Error("findOrCreate missing");
    await adapter.findOrCreate(scope, PROFILE_NETWORK);
    console.log(`[${tag}] findOrCreate-network ok`);
  } else if (action === "destroyScope") {
    if (adapter.destroyScope === undefined) throw new Error("destroyScope missing");
    const removed = await adapter.destroyScope(scope);
    console.log(`[${tag}] destroyScope removed=${removed}`);
  } else {
    console.error(`[${tag}] unknown action: ${action}`);
    process.exit(2);
  }
  process.exit(0);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[${tag}] action ${action} failed: ${msg}`);
  process.exit(1);
}
