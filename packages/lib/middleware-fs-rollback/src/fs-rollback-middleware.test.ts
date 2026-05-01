import { describe, expect, test } from "bun:test";
import type { JsonObject, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { createMockTurnContext } from "@koi/test";
import { createFsRollbackMiddleware } from "./fs-rollback-middleware.js";
import type { RunGitFn, RunGitOutcome } from "./types.js";

const ctx: TurnContext = createMockTurnContext();

interface RecordedCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

interface MockGit {
  readonly fn: RunGitFn;
  readonly calls: readonly RecordedCall[];
}

/**
 * Build a programmable git mock. The handler is invoked with the argv
 * (no leading "git") and is expected to return the runtime outcome. A
 * default fallback returns `{ ok: true, stdout: "", stderr: "" }` so
 * tests only need to handle the commands that matter.
 */
function makeMockGit(
  handler: (args: readonly string[]) => Partial<RunGitOutcome> | undefined,
): MockGit {
  const calls: RecordedCall[] = [];
  const fn: RunGitFn = async (args, cwd): Promise<RunGitOutcome> => {
    calls.push({ args, cwd });
    const partial = handler(args);
    return {
      ok: partial?.ok ?? true,
      stdout: partial?.stdout ?? "",
      stderr: partial?.stderr ?? "",
    };
  };
  return { fn, calls };
}

const REPO_ROOT = "/tmp/fake-repo";
const CWD = REPO_ROOT;

function gitHandler(opts: {
  readonly statusDirty?: boolean;
  readonly stashListExtra?: readonly string[];
  readonly popOk?: boolean;
}): (args: readonly string[]) => Partial<RunGitOutcome> | undefined {
  // `let`: tracks the last stash token registered via `stash push` so the
  // handler can echo it back from `stash list` queries.
  let lastToken: string | undefined;
  return (args: readonly string[]): Partial<RunGitOutcome> | undefined => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { ok: true, stdout: REPO_ROOT };
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      return { ok: true, stdout: opts.statusDirty === false ? "" : " M file.txt" };
    }
    if (args[0] === "stash" && args[1] === "push") {
      const tokenIdx = args.indexOf("--message");
      lastToken = tokenIdx >= 0 ? args[tokenIdx + 1] : undefined;
      return { ok: true, stdout: "Saved working directory and index state" };
    }
    if (args[0] === "stash" && args[1] === "list") {
      const lines: string[] = [];
      if (lastToken !== undefined) lines.push(`stash@{0}: On main: ${lastToken}`);
      for (const extra of opts.stashListExtra ?? []) lines.push(extra);
      return { ok: true, stdout: lines.join("\n") };
    }
    if (args[0] === "stash" && args[1] === "pop") {
      return opts.popOk === false
        ? { ok: false, stderr: "CONFLICT (content): Merge conflict in file.txt" }
        : { ok: true, stdout: "" };
    }
    if (args[0] === "stash" && args[1] === "drop") {
      return { ok: true, stdout: "" };
    }
    return undefined;
  };
}

function fsWriteRequest(path = "file.txt", callId = "tcid-1"): ToolRequest {
  const input: JsonObject = { path, content: "hello" };
  return { toolId: "fs_write", input, callId };
}

describe("createFsRollbackMiddleware", () => {
  test("middleware identity", () => {
    const handle = createFsRollbackMiddleware({ runGit: makeMockGit(() => undefined).fn });
    expect(handle.middleware.name).toBe("fs-rollback");
    expect(handle.middleware.priority).toBe(180);
    const cap = handle.middleware.describeCapabilities?.(ctx);
    expect(cap?.label).toBe("fs-rollback");
  });

  test("non-protected tool passes through without git activity", async () => {
    const mock = makeMockGit(gitHandler({}));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");

    const next = async (): Promise<ToolResponse> => ({ output: "ok" });
    const resp = await wrap(ctx, { toolId: "echo", input: {} }, next);

    expect(resp.output).toBe("ok");
    expect(mock.calls.length).toBe(0);
  });

  test("snapshot taken before fs_write call", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();

    // `let`: ordering check — capture the call index at which `next` runs.
    let nextCalledAt = -1;
    const next = async (): Promise<ToolResponse> => {
      nextCalledAt = mock.calls.length;
      return { output: "ok" };
    };
    await wrap(ctx, fsWriteRequest(), next);

    const stashPushIdx = mock.calls.findIndex((c) => c.args[0] === "stash" && c.args[1] === "push");
    expect(stashPushIdx).toBeGreaterThanOrEqual(0);
    expect(stashPushIdx).toBeLessThan(nextCalledAt);
    // Drop on success
    const dropIdx = mock.calls.findIndex((c) => c.args[0] === "stash" && c.args[1] === "drop");
    expect(dropIdx).toBeGreaterThan(nextCalledAt);
  });

  test("restore on tool throw, then re-throws original", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const original = new Error("tool blew up");
    const next = async (): Promise<ToolResponse> => {
      throw original;
    };

    await expect(wrap(ctx, fsWriteRequest(), next)).rejects.toBe(original);

    const popped = mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "pop");
    expect(popped).toBeDefined();
  });

  test("restore on failing ToolResponse (blockedByHook)", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const failResp: ToolResponse = {
      output: "blocked",
      metadata: { blockedByHook: true } as JsonObject,
    };
    const next = async (): Promise<ToolResponse> => failResp;

    const resp = await wrap(ctx, fsWriteRequest(), next);
    expect(resp).toBe(failResp);
    expect(mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "pop")).toBeDefined();
    expect(mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "drop")).toBeUndefined();
  });

  test("restore on failing ToolResponse (non-zero exitCode)", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => ({
      output: "fail",
      metadata: { exitCode: 1 } as JsonObject,
    });
    await wrap(ctx, fsWriteRequest(), next);
    expect(mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "pop")).toBeDefined();
  });

  test("out-of-repo path: no snapshot, no rollback", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const original = new Error("blew up");
    const next = async (): Promise<ToolResponse> => {
      throw original;
    };
    await expect(wrap(ctx, fsWriteRequest("/other/dir/file.txt"), next)).rejects.toBe(original);
    // Only rev-parse should have run; no stash activity.
    expect(mock.calls.find((c) => c.args[0] === "stash")).toBeUndefined();
  });

  test("non-git directory: middleware no-ops + warns once", async () => {
    const mock = makeMockGit((args) => {
      if (args[0] === "rev-parse") return { ok: false, stderr: "not a git repository" };
      return undefined;
    });
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: "/tmp/nogit" });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();

    // Capture stderr / console.warn.
    const originalWarn = console.warn;
    // `let`: collect warning invocations
    let warnCount = 0;
    console.warn = (..._a: unknown[]): void => {
      warnCount += 1;
    };
    try {
      const next = async (): Promise<ToolResponse> => ({ output: "ok" });
      await wrap(ctx, fsWriteRequest(), next);
      await wrap(ctx, fsWriteRequest("file2.txt"), next);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnCount).toBe(1);
    // Only rev-parse — no stash on either call.
    expect(mock.calls.find((c) => c.args[0] === "stash")).toBeUndefined();
  });

  test("stash pop conflict surfaces as KoiError(INTERNAL) with stashRef", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true, popOk: false }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      throw new Error("inner failure");
    };

    try {
      await wrap(ctx, fsWriteRequest(), next);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const err = e as {
        readonly code?: string;
        readonly retryable?: boolean;
        readonly context?: { readonly stashRef?: string };
        readonly internal?: boolean;
      };
      expect(err.code).toBe("INTERNAL");
      expect(err.retryable).toBe(false);
      expect(err.internal).toBe(true);
      expect(err.context?.stashRef).toContain("koi-fs-rollback:");
    }
  });

  test("clean working tree: no stash created, no pop on tool failure", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: false }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      throw new Error("fail");
    };
    await expect(wrap(ctx, fsWriteRequest(), next)).rejects.toThrow("fail");
    // Status check ran, but no stash push/pop.
    expect(mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "push")).toBeUndefined();
    expect(mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "pop")).toBeUndefined();
  });

  test("concurrent calls with different sessionIds match their own stash entries", async () => {
    // Two independent middleware instances simulate two concurrent sessions
    // sharing a single git repo. Each should pop its own entry.
    const sharedMock = makeMockGit(gitHandler({ statusDirty: true }));
    const handleA = createFsRollbackMiddleware({ runGit: sharedMock.fn, cwd: CWD });
    const handleB = createFsRollbackMiddleware({ runGit: sharedMock.fn, cwd: CWD });
    const wrapA = handleA.middleware.wrapToolCall;
    const wrapB = handleB.middleware.wrapToolCall;
    if (!wrapA || !wrapB) throw new Error();

    const ctxA = createMockTurnContext();
    const ctxB = createMockTurnContext();

    const fail = async (): Promise<ToolResponse> => {
      throw new Error("fail");
    };
    const okHandler = async (): Promise<ToolResponse> => ({ output: "ok" });

    await wrapA(ctxA, fsWriteRequest("a.txt", "callA"), okHandler);
    await expect(wrapB(ctxB, fsWriteRequest("b.txt", "callB"), fail)).rejects.toThrow("fail");

    // Pop ref should have been resolved by token (re-listing) not by index.
    const popCall = sharedMock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "pop");
    expect(popCall).toBeDefined();
    expect(popCall?.args[2]).toBe("stash@{0}");
  });

  test("custom protectedTools includes Bash", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({
      runGit: mock.fn,
      cwd: CWD,
      protectedTools: ["Bash"],
    });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();

    const next = async (): Promise<ToolResponse> => ({ output: "ok" });
    await wrap(
      ctx,
      { toolId: "Bash", input: { path: "out.txt", cmd: "echo hi" } as JsonObject },
      next,
    );
    expect(mock.calls.find((c) => c.args[0] === "stash" && c.args[1] === "push")).toBeDefined();
  });

  test("default protected tools include fs_write and fs_edit", async () => {
    const mock = makeMockGit(gitHandler({ statusDirty: true }));
    const handle = createFsRollbackMiddleware({ runGit: mock.fn, cwd: CWD });
    const wrap = handle.middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => ({ output: "ok" });

    await wrap(ctx, { toolId: "fs_edit", input: { path: "x.txt" } as JsonObject }, next);
    const pushCount = mock.calls.filter(
      (c) => c.args[0] === "stash" && c.args[1] === "push",
    ).length;
    expect(pushCount).toBe(1);
  });

  test("binary file roundtrip — random bytes survive stash push/pop", async (): Promise<void> => {
    // Real-git smoke test: init a temp repo with a real binary file, run
    // the middleware against it, verify the bytes after rollback match.
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "koi-fs-rollback-bin-"));
    try {
      // Use the REAL git seam (no mock) for this end-to-end byte check.
      const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      if (init.exitCode !== 0) throw new Error("git init failed");
      Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd: dir });
      Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: dir });

      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) original[i] = i;
      const filePath = join(dir, "blob.bin");
      writeFileSync(filePath, original);
      Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
      Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: dir });

      // Now mutate the file, then have the tool throw — middleware must
      // restore the committed bytes.
      const corrupted = new Uint8Array(256);
      for (let i = 0; i < 256; i++) corrupted[i] = (i + 17) & 0xff;

      const handle = createFsRollbackMiddleware({ cwd: dir });
      const wrap = handle.middleware.wrapToolCall;
      if (!wrap) throw new Error();

      // Need a dirty status FIRST so stash has something to capture. Set
      // the file to preDirty bytes; we expect rollback to restore exactly
      // these after the tool fails.
      const preDirty = new Uint8Array(256);
      for (let i = 0; i < 256; i++) preDirty[i] = (i + 1) & 0xff;
      writeFileSync(filePath, preDirty);

      // Tool throws WITHOUT touching the file: pop has no conflict so we
      // can isolate the binary-roundtrip property of stash itself.
      // After push: working tree = HEAD (original). Then throw. Then pop
      // applies the preDirty diff cleanly back over original.
      const next = async (_req: ToolRequest): Promise<ToolResponse> => {
        // Verify push actually reverted the tree to HEAD before tool ran.
        const inflight = readFileSync(filePath);
        if (inflight[0] !== 0 || inflight[255] !== 255) {
          throw new Error(
            `pre-tool tree not at HEAD: byte0=${inflight[0]}, byte255=${inflight[255]}`,
          );
        }
        // Reference bytes used to keep the linter quiet about unused locals.
        if (corrupted[0] === inflight[0]) {
          /* no-op */
        }
        throw new Error("crash mid-write");
      };

      await expect(wrap(ctx, fsWriteRequest("blob.bin", "binary-call"), next)).rejects.toThrow();

      const restored = readFileSync(filePath);
      // After pop, working tree must equal preDirty (the snapshotted state).
      expect(restored.length).toBe(256);
      // `let`: track byte-mismatch index for diagnostic
      let mismatchAt = -1;
      for (let i = 0; i < 256; i++) {
        if (restored[i] !== preDirty[i]) {
          mismatchAt = i;
          break;
        }
      }
      expect(mismatchAt).toBe(-1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
