/**
 * Op-kind × content-type matrix per #1625 design review issue 10A.
 *
 * Verifies that capture works correctly across the cross product of:
 *   create / edit / delete  ×  empty / text / binary / chunk-boundary / large
 *
 * Plus targeted edge cases:
 *   - rename (delete + create with shared logical operation)
 *   - unicode path
 *   - file with no trailing newline vs with trailing newline
 *   - whitespace-only content
 *
 * Tests construct synthetic ToolRequest objects, drive the middleware, and
 * inspect the resulting FileOpRecord against the expected kind and hashes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JsonObject,
  KoiMiddleware,
  RunId,
  SessionContext,
  SessionId,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { chainId } from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { createCheckpointMiddleware } from "../checkpoint-middleware.js";
import type { CheckpointPayload, DriftDetector } from "../types.js";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const PASSTHROUGH: ToolResponse = { output: { ok: true } };

interface Rig {
  middleware: KoiMiddleware;
  store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  workDir: string;
  blobDir: string;
  cleanup(): void;
}

function makeRig(): Rig {
  const blobDir = join(tmpdir(), `koi-cp-mat-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-cp-mat-work-"));
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
  const middleware = createCheckpointMiddleware({
    store,
    config: { blobDir, driftDetector: NULL_DRIFT },
  });
  return {
    middleware,
    store,
    workDir,
    blobDir,
    cleanup() {
      store.close();
      rmSync(blobDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function makeTurn(suffix: string): TurnContext {
  const session: SessionContext = {
    agentId: `agent-${suffix}`,
    sessionId: `session-${suffix}` as SessionId,
    runId: `run-${suffix}` as RunId,
    metadata: {},
  };
  return {
    session,
    turnIndex: 0,
    turnId: `turn-${suffix}` as TurnId,
    messages: [],
    metadata: {},
  };
}

async function runFsWrite(
  rig: Rig,
  ctx: TurnContext,
  path: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const wrap = rig.middleware.wrapToolCall;
  if (wrap === undefined) throw new Error("no wrapToolCall");
  await wrap(
    ctx,
    {
      toolId: "fs_write",
      input: { path, content: typeof bytes === "string" ? bytes : "<binary>" } as JsonObject,
    },
    async (_req): Promise<ToolResponse> => {
      writeFileSync(path, bytes);
      return PASSTHROUGH;
    },
  );
}

async function runFsDelete(rig: Rig, ctx: TurnContext, path: string): Promise<void> {
  // There's no built-in fs_delete tool yet, so we drive a custom tool
  // that the middleware will track via trackedToolIds. We do this via
  // a one-off middleware instance per test (only used in the rename
  // test below) — for the standard delete-via-edit case, we just call
  // unlink in the tool handler.
  const wrap = rig.middleware.wrapToolCall;
  if (wrap === undefined) throw new Error("no wrapToolCall");
  await wrap(
    ctx,
    { toolId: "fs_write", input: { path } as JsonObject },
    async (_req): Promise<ToolResponse> => {
      unlinkSync(path);
      return PASSTHROUGH;
    },
  );
}

async function flushTurn(rig: Rig, ctx: TurnContext): Promise<CheckpointPayload> {
  const onAfter = rig.middleware.onAfterTurn;
  if (onAfter === undefined) throw new Error("no onAfterTurn");
  await onAfter(ctx);
  const head = rig.store.head(chainId(String(ctx.session.sessionId)));
  if (!head.ok || head.value === undefined) throw new Error("no head");
  return head.value.data;
}

// ---------------------------------------------------------------------------
// Content variants
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 64 * 1024;

const variants: ReadonlyArray<{ name: string; bytes: string | Uint8Array }> = [
  { name: "empty", bytes: "" },
  { name: "small-text", bytes: "hello world" },
  { name: "binary-image-bytes", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
  { name: "chunk-boundary-just-under", bytes: "x".repeat(CHUNK_SIZE - 1) },
  { name: "chunk-boundary-exact", bytes: "x".repeat(CHUNK_SIZE) },
  { name: "chunk-boundary-just-over", bytes: "x".repeat(CHUNK_SIZE + 1) },
  { name: "no-trailing-newline", bytes: "line1\nline2" },
  { name: "trailing-newline", bytes: "line1\nline2\n" },
  { name: "whitespace-only", bytes: "   \n\t  " },
];

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

describe("op-kind × content-type matrix", () => {
  let rig: Rig;

  beforeEach(() => {
    rig = makeRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  for (const variant of variants) {
    test(`create — ${variant.name}`, async () => {
      const ctx = makeTurn(`create-${variant.name}`);
      const target = join(rig.workDir, `${variant.name}-create`);
      await runFsWrite(rig, ctx, target, variant.bytes);
      const payload = await flushTurn(rig, ctx);
      expect(payload.fileOps.length).toBe(1);
      expect(payload.fileOps[0]?.kind).toBe("create");
    });

    test(`edit — ${variant.name}`, async () => {
      const ctx = makeTurn(`edit-${variant.name}`);
      const target = join(rig.workDir, `${variant.name}-edit`);
      // Pre-existing file with different content so the post-image differs.
      writeFileSync(target, "PRE");
      await runFsWrite(rig, ctx, target, variant.bytes);
      const payload = await flushTurn(rig, ctx);
      // Edge case: if `variant.bytes` happens to equal "PRE" we'd get a
      // no-op. None of our variants are exactly "PRE", so this is safe.
      expect(payload.fileOps.length).toBe(1);
      expect(payload.fileOps[0]?.kind).toBe("edit");
    });

    test(`delete — ${variant.name}`, async () => {
      const ctx = makeTurn(`delete-${variant.name}`);
      const target = join(rig.workDir, `${variant.name}-delete`);
      writeFileSync(target, variant.bytes);
      await runFsDelete(rig, ctx, target);
      const payload = await flushTurn(rig, ctx);
      expect(payload.fileOps.length).toBe(1);
      expect(payload.fileOps[0]?.kind).toBe("delete");
    });
  }

  test("large file (10 MB) creates correctly via streaming", async () => {
    const ctx = makeTurn("large-create");
    const target = join(rig.workDir, "large.bin");
    const big = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;

    await runFsWrite(rig, ctx, target, big);
    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(1);
    expect(payload.fileOps[0]?.kind).toBe("create");
  });

  test("rename modeled as delete + create across two tool calls", async () => {
    // Rename = delete the old path + create a new path with the same
    // content. Both ops fire under the same fs_write tool. The middleware
    // captures them as two separate FileOpRecord entries; the spec says
    // they may share an optional renameId, but the middleware doesn't
    // synthesize one (the tool would have to). Verify the records exist
    // with matching hashes.
    const ctx = makeTurn("rename");
    const oldPath = join(rig.workDir, "old.txt");
    const newPath = join(rig.workDir, "new.txt");
    writeFileSync(oldPath, "rename me");

    // Step 1: delete old
    await runFsDelete(rig, ctx, oldPath);
    // Step 2: create new with same content
    await runFsWrite(rig, ctx, newPath, "rename me");

    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(2);

    const deleted = payload.fileOps.find((op) => op.kind === "delete");
    const created = payload.fileOps.find((op) => op.kind === "create");
    expect(deleted).toBeDefined();
    expect(created).toBeDefined();
    if (deleted?.kind === "delete" && created?.kind === "create") {
      // Same content → same hash. CAS dedups; both records reference one blob.
      expect(deleted.preContentHash).toBe(created.postContentHash);
    }
  });

  test("unicode path is captured correctly", async () => {
    const ctx = makeTurn("unicode");
    const target = join(rig.workDir, "héllo-世界-🌟.txt");
    await runFsWrite(rig, ctx, target, "unicode content");
    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(1);
    expect(payload.fileOps[0]?.path).toBe(target);
  });

  test("path with spaces is captured correctly", async () => {
    const ctx = makeTurn("spaces");
    const target = join(rig.workDir, "file with spaces.txt");
    await runFsWrite(rig, ctx, target, "spaced");
    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(1);
    expect(payload.fileOps[0]?.path).toBe(target);
  });

  test("very long filename is captured correctly", async () => {
    const ctx = makeTurn("long");
    // 200 char filename — under most filesystem limits but well past sane.
    const longName = `${"a".repeat(200)}.txt`;
    const target = join(rig.workDir, longName);
    await runFsWrite(rig, ctx, target, "long");
    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(1);
    expect(payload.fileOps[0]?.path).toBe(target);
  });

  test("multiple ops in one turn are all captured in order", async () => {
    const ctx = makeTurn("multi");
    const a = join(rig.workDir, "a.txt");
    const b = join(rig.workDir, "b.txt");
    const c = join(rig.workDir, "c.txt");

    await runFsWrite(rig, ctx, a, "a");
    await runFsWrite(rig, ctx, b, "b");
    await runFsWrite(rig, ctx, c, "c");

    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(3);
    expect(payload.fileOps.map((o) => o.path)).toEqual([a, b, c]);
    expect(payload.fileOps.map((o) => o.eventIndex)).toEqual([0, 1, 2]);
  });

  test("op against a missing file (no pre, no post, tool no-op) records nothing", async () => {
    const ctx = makeTurn("noop");
    const target = join(rig.workDir, "ghost.txt");
    expect(existsSync(target)).toBe(false);
    const wrap = rig.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("no wrap");
    await wrap(
      ctx,
      { toolId: "fs_write", input: { path: target } as JsonObject },
      async () => PASSTHROUGH, // tool didn't actually write
    );
    const payload = await flushTurn(rig, ctx);
    expect(payload.fileOps.length).toBe(0);
  });
});
