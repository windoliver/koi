/**
 * Comprehensive E2E validation of the five #1625 rewind scenarios.
 *
 * Runs programmatically against the actual @koi/checkpoint factory with
 * the same config the TUI uses (same resolvePath, same SQLite path shape).
 * No agent/LLM involved — direct middleware invocation with synthetic
 * TurnContexts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointPayload, DriftDetector } from "@koi/checkpoint";
import { createCheckpoint } from "@koi/checkpoint";
import {
  sessionId as makeSessionId,
  type RunId,
  type SessionId,
  type TurnContext,
  type TurnId,
} from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const PASSTHROUGH = { output: { ok: true } };

// Mirror the TUI's resolvePath exactly: absolute paths under cwd pass
// through, anything else is treated as workspace-relative and resolved
// against cwd.
function makeResolver(cwd: string): (virtualPath: string) => string {
  return (virtualPath: string): string => {
    if (virtualPath === cwd || virtualPath.startsWith(`${cwd}/`)) return virtualPath;
    const stripped = virtualPath.startsWith("/") ? virtualPath.slice(1) : virtualPath;
    return join(cwd, stripped);
  };
}

interface Rig {
  cwd: string;
  store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  checkpoint: ReturnType<typeof createCheckpoint>;
  snapshotDir: string;
  blobDir: string;
  cleanup(): void;
}

function makeRig(opts: { driftDetector?: DriftDetector } = {}): Rig {
  // realpathSync because macOS /tmp → /private/tmp, and bun's process.cwd()
  // reports the realpath — our cwd must match what the tool handler sees.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "koi-sc-")));
  const workspaceHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const snapshotDir = mkdtempSync(join(tmpdir(), "koi-sc-snap-"));
  const blobDir = mkdtempSync(join(tmpdir(), "koi-sc-blobs-"));
  const snapshotPath = join(snapshotDir, `${workspaceHash}.sqlite`);
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: snapshotPath });
  const checkpoint = createCheckpoint({
    store,
    config: {
      blobDir,
      driftDetector: opts.driftDetector ?? NULL_DRIFT,
      resolvePath: makeResolver(cwd),
    },
  });
  return {
    cwd,
    store,
    checkpoint,
    snapshotDir,
    blobDir,
    cleanup() {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(snapshotDir, { recursive: true, force: true });
      rmSync(blobDir, { recursive: true, force: true });
    },
  };
}

function ctx(sid: SessionId, turnIndex: number): TurnContext {
  return {
    session: { agentId: "a", sessionId: sid, runId: "r" as RunId, metadata: {} },
    turnIndex,
    turnId: `t-${turnIndex}` as TurnId,
    messages: [],
    metadata: {},
  };
}

/**
 * Simulate an `fs_write` tool call. The agent sees `virtualPath` (possibly
 * a virtualized path like "/workspace/foo"); the tool handler writes to the
 * resolved `realPath` that `@koi/fs-local` would compute.
 */
async function fsWrite(
  rig: { checkpoint: Rig["checkpoint"]; cwd: string },
  turn: TurnContext,
  virtualPath: string,
  content: string,
): Promise<void> {
  const realPath = makeResolver(rig.cwd)(virtualPath);
  const wrap = rig.checkpoint.middleware.wrapToolCall;
  if (wrap === undefined) throw new Error("no wrapToolCall");
  await wrap(turn, { toolId: "fs_write", input: { path: virtualPath, content } }, async () => {
    mkdirSync(join(realPath, ".."), { recursive: true });
    writeFileSync(realPath, content);
    return PASSTHROUGH;
  });
}

async function endTurn(checkpoint: Rig["checkpoint"], turn: TurnContext): Promise<void> {
  const onAfter = checkpoint.middleware.onAfterTurn;
  if (onAfter === undefined) throw new Error("no onAfterTurn");
  await onAfter(turn);
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: single-turn rewind
// ---------------------------------------------------------------------------
console.log("\n[Scenario 1] Single-turn /rewind");
{
  const rig = makeRig();
  const sid = makeSessionId("sc1");
  const realPath = join(rig.cwd, "a.txt");

  await fsWrite(rig, ctx(sid, 0), "a.txt", "v1");
  await endTurn(rig.checkpoint, ctx(sid, 0));
  check("file created", existsSync(realPath));

  const r = await rig.checkpoint.rewind(sid, 1);
  check("rewind ok", r.ok, r.ok ? undefined : r.error.message);
  check("file deleted after rewind", !existsSync(realPath));
  rig.cleanup();
}

// ---------------------------------------------------------------------------
// Scenario 2: multi-turn /rewind N
// ---------------------------------------------------------------------------
console.log("\n[Scenario 2] Multi-turn /rewind 3");
{
  const rig = makeRig();
  const sid = makeSessionId("sc2");
  const a = join(rig.cwd, "a.txt");
  const b = join(rig.cwd, "b.txt");
  const c = join(rig.cwd, "c.txt");

  await fsWrite(rig, ctx(sid, 0), "a.txt", "a-v1");
  await endTurn(rig.checkpoint, ctx(sid, 0));
  await fsWrite(rig, ctx(sid, 1), "b.txt", "b-v1");
  await endTurn(rig.checkpoint, ctx(sid, 1));
  await fsWrite(rig, ctx(sid, 2), "c.txt", "c-v1");
  await endTurn(rig.checkpoint, ctx(sid, 2));
  check("all 3 files exist", existsSync(a) && existsSync(b) && existsSync(c));

  const r = await rig.checkpoint.rewind(sid, 3);
  check("rewind 3 ok", r.ok, r.ok ? undefined : r.error.message);
  check("all 3 files deleted", !existsSync(a) && !existsSync(b) && !existsSync(c));
  rig.cleanup();
}

// ---------------------------------------------------------------------------
// Scenario 3: drift warning surfaces on the RewindResult
// ---------------------------------------------------------------------------
console.log("\n[Scenario 3] Drift warning wiring");
{
  const DRIFT_DETECTOR: DriftDetector = { detect: async () => [" M drift-example.ts"] };
  const rig = makeRig({ driftDetector: DRIFT_DETECTOR });
  const sid = makeSessionId("sc3");

  await fsWrite(rig, ctx(sid, 0), "a.txt", "v1");
  await endTurn(rig.checkpoint, ctx(sid, 0));
  // Drift runs in a deferred queueMicrotask — yield the event loop so it
  // can fire (though the current implementation doesn't persist results
  // back into the just-written snapshot; that's the known "drift UI
  // rendering" follow-up).
  await new Promise((r) => setImmediate(r));

  const r = await rig.checkpoint.rewind(sid, 1);
  check("rewind ok", r.ok, r.ok ? undefined : r.error.message);
  check("rewind result carries driftWarnings array", r.ok && Array.isArray(r.driftWarnings));
  rig.cleanup();
}

// ---------------------------------------------------------------------------
// Scenario 4: durable chain survives "restart" (close + reopen SQLite)
// ---------------------------------------------------------------------------
console.log("\n[Scenario 4] Durable chain across simulated restart");
{
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "koi-sc4-")));
  const workspaceHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const snapshotDir = mkdtempSync(join(tmpdir(), "koi-sc4-snap-"));
  const blobDir = mkdtempSync(join(tmpdir(), "koi-sc4-blobs-"));
  const snapshotPath = join(snapshotDir, `${workspaceHash}.sqlite`);
  const sid = makeSessionId("sc4");
  const realPath = join(cwd, "persistent.txt");

  // First "session"
  {
    const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: snapshotPath });
    const checkpoint = createCheckpoint({
      store,
      config: { blobDir, driftDetector: NULL_DRIFT, resolvePath: makeResolver(cwd) },
    });
    await fsWrite({ checkpoint, cwd }, ctx(sid, 0), "persistent.txt", "persistent-v1");
    await endTurn(checkpoint, ctx(sid, 0));
    store.close();
    check("file exists after first session", existsSync(realPath));
  }

  // Second "session" — reopen the same SQLite file
  {
    const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: snapshotPath });
    const checkpoint = createCheckpoint({
      store,
      config: { blobDir, driftDetector: NULL_DRIFT, resolvePath: makeResolver(cwd) },
    });
    const r = await checkpoint.rewind(sid, 1);
    check("rewind after restart ok", r.ok, r.ok ? undefined : r.error.message);
    check("file deleted after restart + rewind", !existsSync(realPath));
    store.close();
  }

  rmSync(cwd, { recursive: true, force: true });
  rmSync(snapshotDir, { recursive: true, force: true });
  rmSync(blobDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Scenario 5: virtual path resolution (TUI case — "/workspace/foo" maps to <cwd>/workspace/foo)
// ---------------------------------------------------------------------------
console.log("\n[Scenario 5] Virtual path resolution via resolvePath hook");
{
  const rig = makeRig();
  const sid = makeSessionId("sc5");
  const virtualPath = "/workspace/virtual-file.txt";
  const realPath = join(rig.cwd, "workspace", "virtual-file.txt");

  await fsWrite(rig, ctx(sid, 0), virtualPath, "virtual-v1");
  await endTurn(rig.checkpoint, ctx(sid, 0));
  check("file at resolved real path", existsSync(realPath));

  const r = await rig.checkpoint.rewind(sid, 1);
  check("rewind ok", r.ok, r.ok ? undefined : r.error.message);
  check("file deleted (resolver mapped virtual → real)", !existsSync(realPath));
  rig.cleanup();
}

console.log(`\n=== RESULTS ===`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
