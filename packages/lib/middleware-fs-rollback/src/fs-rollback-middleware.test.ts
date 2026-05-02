import { describe, expect, test } from "bun:test";
import type { JsonObject, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { createMockTurnContext } from "@koi/test";
import { createFsRollbackMiddleware } from "./fs-rollback-middleware.js";
import type { FsSeam } from "./types.js";

const ctx: TurnContext = createMockTurnContext();
const CWD = "/tmp/repo";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string =>
  b === undefined ? "" : new TextDecoder().decode(b);

interface MockFs {
  readonly seam: FsSeam;
  readonly files: Map<string, Uint8Array>;
  readonly reads: string[];
  readonly writes: string[];
  readonly unlinks: string[];
}

function makeMockFs(initial: Record<string, Uint8Array> = {}): MockFs {
  const files = new Map<string, Uint8Array>(Object.entries(initial));
  const reads: string[] = [];
  const writes: string[] = [];
  const unlinks: string[] = [];
  const stat = { mtimeMs: 1, size: 1, ino: 1, kind: "file" as const };
  const seam: FsSeam = {
    async read(path) {
      reads.push(path);
      const b = files.get(path);
      return b === undefined ? { existed: false } : { existed: true, bytes: b, stat };
    },
    async stat(path) {
      return files.has(path) ? stat : undefined;
    },
    async write(path, bytes) {
      files.set(path, bytes);
      writes.push(path);
    },
    async atomicWrite(path, bytes) {
      files.set(path, bytes);
      writes.push(path);
    },
    async unlink(path) {
      files.delete(path);
      unlinks.push(path);
    },
  };
  return { seam, files, reads, writes, unlinks };
}

function fsWriteRequest(path = "file.txt", callId = "tcid-1"): ToolRequest {
  const input: JsonObject = { path, content: "hello" };
  return { toolId: "fs_write", input, callId };
}

describe("createFsRollbackMiddleware", () => {
  test("middleware identity", () => {
    const handle = createFsRollbackMiddleware({});
    expect(handle.middleware.name).toBe("fs-rollback");
    expect(handle.middleware.priority).toBe(180);
    expect(handle.middleware.describeCapabilities?.(ctx)?.label).toBe("fs-rollback");
  });

  test("non-protected tool passes through, no fs activity", async () => {
    const mock = makeMockFs();
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error("wrapToolCall missing");
    const next = async (): Promise<ToolResponse> => ({ output: "ok" });
    const resp = await wrap(ctx, { toolId: "echo", input: {} }, next);
    expect(resp.output).toBe("ok");
    expect(mock.reads.length).toBe(0);
    expect(mock.writes.length).toBe(0);
    expect(mock.unlinks.length).toBe(0);
  });

  test("missing path: passes through without snapshotting", async () => {
    const mock = makeMockFs();
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => ({ output: "ok" });
    await wrap(ctx, { toolId: "fs_write", input: {} }, next);
    expect(mock.reads.length).toBe(0);
  });

  test("snapshot is taken before next() runs", async () => {
    const mock = makeMockFs({ "/tmp/repo/file.txt": enc("PRE") });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    // let: ordering check — capture read count at the moment next() runs.
    let readsAtNext = -1;
    const next = async (): Promise<ToolResponse> => {
      readsAtNext = mock.reads.length;
      return { output: "ok" };
    };
    await wrap(ctx, fsWriteRequest(), next);
    expect(readsAtNext).toBe(1);
  });

  test("restores prior bytes when tool throws", async () => {
    const mock = makeMockFs({ "/tmp/repo/file.txt": enc("OLD") });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const original = new Error("blew up");
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/file.txt", enc("CORRUPT"));
      throw original;
    };
    await expect(wrap(ctx, fsWriteRequest(), next)).rejects.toBe(original);
    expect(dec(mock.files.get("/tmp/repo/file.txt"))).toBe("OLD");
  });

  test("unlinks newly-created file when tool throws", async () => {
    const mock = makeMockFs(); // file does not exist yet
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/new.txt", enc("partial"));
      throw new Error("crash");
    };
    await expect(wrap(ctx, fsWriteRequest("new.txt"), next)).rejects.toThrow("crash");
    expect(mock.files.has("/tmp/repo/new.txt")).toBe(false);
  });

  test("preserves new file on success", async () => {
    const mock = makeMockFs();
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/new.txt", enc("kept"));
      return { output: "ok" };
    };
    await wrap(ctx, fsWriteRequest("new.txt"), next);
    expect(dec(mock.files.get("/tmp/repo/new.txt"))).toBe("kept");
  });

  test("restore on failing ToolResponse (blockedByHook)", async () => {
    const mock = makeMockFs({ "/tmp/repo/file.txt": enc("PRE") });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/file.txt", enc("DURING"));
      return { output: "blocked", metadata: { blockedByHook: true } as JsonObject };
    };
    await wrap(ctx, fsWriteRequest(), next);
    expect(dec(mock.files.get("/tmp/repo/file.txt"))).toBe("PRE");
  });

  test("restore on failing ToolResponse (non-zero exitCode)", async () => {
    const mock = makeMockFs({ "/tmp/repo/file.txt": enc("PRE") });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/file.txt", enc("DURING"));
      return { output: "fail", metadata: { exitCode: 1 } as JsonObject };
    };
    await wrap(ctx, fsWriteRequest(), next);
    expect(dec(mock.files.get("/tmp/repo/file.txt"))).toBe("PRE");
  });

  test("does not touch unrelated files on rollback", async () => {
    const mock = makeMockFs({
      "/tmp/repo/file.txt": enc("PRE"),
      "/tmp/repo/other.txt": enc("UNRELATED"),
    });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/file.txt", enc("X"));
      // Simulate a concurrent unrelated mutation that must NOT be reverted.
      mock.files.set("/tmp/repo/other.txt", enc("ALSO MUTATED"));
      throw new Error("fail");
    };
    await expect(wrap(ctx, fsWriteRequest(), next)).rejects.toThrow("fail");
    expect(dec(mock.files.get("/tmp/repo/file.txt"))).toBe("PRE");
    expect(dec(mock.files.get("/tmp/repo/other.txt"))).toBe("ALSO MUTATED");
  });

  test("preserves unrelated dirty state on success path", async () => {
    // The previous git-stash design wiped pre-existing dirty state on
    // success. The path-scoped design must not.
    const mock = makeMockFs({
      "/tmp/repo/file.txt": enc("PRE"),
      "/tmp/repo/dirty.txt": enc("UNCOMMITTED"),
    });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/file.txt", enc("NEW"));
      return { output: "ok" };
    };
    await wrap(ctx, fsWriteRequest(), next);
    expect(dec(mock.files.get("/tmp/repo/file.txt"))).toBe("NEW");
    expect(dec(mock.files.get("/tmp/repo/dirty.txt"))).toBe("UNCOMMITTED");
  });

  test("rollback failure surfaces INTERNAL error", async () => {
    const erroring: FsSeam = {
      async read() {
        return {
          existed: true,
          bytes: enc("PRE"),
          stat: { mtimeMs: 1, size: 3, ino: 1, kind: "file" },
        };
      },
      async stat() {
        return { mtimeMs: 1, size: 3, ino: 1, kind: "file" };
      },
      async write() {
        /* unused */
      },
      async atomicWrite() {
        throw new Error("atomic write failed");
      },
      async unlink() {
        /* unused */
      },
    };
    const wrap = createFsRollbackMiddleware({ fs: erroring, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      throw new Error("inner");
    };
    try {
      await wrap(ctx, fsWriteRequest(), next);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const err = e as {
        readonly code?: string;
        readonly retryable?: boolean;
        readonly internal?: boolean;
        readonly context?: { readonly path?: string };
      };
      expect(err.code).toBe("INTERNAL");
      expect(err.retryable).toBe(false);
      expect(err.internal).toBe(true);
      expect(err.context?.path).toBe("/tmp/repo/file.txt");
    }
  });

  test("snapshot read failure fails closed (does NOT run the tool)", async () => {
    // let: tracks whether next() ran — must remain false on read failure.
    let nextRan = false;
    const erroring: FsSeam = {
      async read() {
        throw new Error("EACCES");
      },
      async stat() {
        return undefined;
      },
      async write() {
        /* should not run */
      },
      async atomicWrite() {
        /* test stub */
      },
      async unlink() {
        /* should not run */
      },
    };
    const wrap = createFsRollbackMiddleware({ fs: erroring, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      nextRan = true;
      return { output: "ok" };
    };
    try {
      await wrap(ctx, fsWriteRequest(), next);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const err = e as {
        readonly code?: string;
        readonly retryable?: boolean;
        readonly internal?: boolean;
      };
      expect(err.code).toBe("INTERNAL");
      expect(err.retryable).toBe(false);
      expect(err.internal).toBe(true);
    }
    expect(nextRan).toBe(false);
  });

  test("custom single-path protectedTools entry is honored", async () => {
    // Per FsRollbackConfig contract: each protected tool must mutate at
    // most input.path. A custom tool name (like a project-specific
    // single-file writer) is fine; multi-file tools are out of scope.
    const mock = makeMockFs({ "/tmp/repo/out.txt": enc("PRE") });
    const wrap = createFsRollbackMiddleware({
      fs: mock.seam,
      cwd: CWD,
      protectedTools: ["fs_write_v2"],
    }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/out.txt", enc("X"));
      throw new Error("fail");
    };
    await expect(
      wrap(ctx, { toolId: "fs_write_v2", input: { path: "out.txt" } as JsonObject }, next),
    ).rejects.toThrow("fail");
    expect(dec(mock.files.get("/tmp/repo/out.txt"))).toBe("PRE");
  });

  test("default protected tools include fs_write and fs_edit", async () => {
    const mock = makeMockFs({ "/tmp/repo/x.txt": enc("PRE") });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      mock.files.set("/tmp/repo/x.txt", enc("DURING"));
      throw new Error("fail");
    };
    await expect(
      wrap(ctx, { toolId: "fs_edit", input: { path: "x.txt" } as JsonObject }, next),
    ).rejects.toThrow();
    expect(dec(mock.files.get("/tmp/repo/x.txt"))).toBe("PRE");
  });

  test("path escape via ../: passthrough, no snapshot, warn-once", async () => {
    const mock = makeMockFs({ "/elsewhere.txt": enc("OUTSIDE") });
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      throw new Error("fail");
    };
    const origWarn = console.warn;
    // let: counts warn invocations
    let warnCount = 0;
    console.warn = (..._a: unknown[]): void => {
      warnCount += 1;
    };
    try {
      await expect(wrap(ctx, fsWriteRequest("../../elsewhere.txt"), next)).rejects.toThrow("fail");
      await expect(wrap(ctx, fsWriteRequest("../../again.txt"), next)).rejects.toThrow("fail");
    } finally {
      console.warn = origWarn;
    }
    expect(warnCount).toBe(1);
    expect(mock.reads.length).toBe(0);
    expect(mock.writes.length).toBe(0);
    expect(mock.unlinks.length).toBe(0);
  });

  test("absolute path outside cwd: passthrough, no snapshot", async () => {
    const mock = makeMockFs();
    const wrap = createFsRollbackMiddleware({ fs: mock.seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => ({ output: "ok" });
    const origWarn = console.warn;
    console.warn = () => undefined;
    try {
      await wrap(ctx, fsWriteRequest("/etc/hosts"), next);
    } finally {
      console.warn = origWarn;
    }
    expect(mock.reads.length).toBe(0);
  });

  test("symlinked parent that escapes cwd: passthrough (realpath containment)", async () => {
    // Build: <workspace>/proxy → <outside>. Path "proxy/secret.txt" looks
    // contained lexically but realpath resolves outside the workspace.
    const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const outside = mkdtempSync(join(tmpdir(), "koi-fsrb-outside-"));
    const workspace = mkdtempSync(join(tmpdir(), "koi-fsrb-ws-"));
    try {
      symlinkSync(outside, join(workspace, "proxy"));
      // Track whether the (production) seam was hit — it shouldn't be,
      // because the containment guard runs before any read.
      // let: tracks next() invocation
      let nextRan = false;
      const handle = createFsRollbackMiddleware({ cwd: workspace });
      const wrap = handle.middleware.wrapToolCall;
      if (!wrap) throw new Error();
      const next = async (): Promise<ToolResponse> => {
        nextRan = true;
        return { output: "ok" };
      };
      const origWarn = console.warn;
      console.warn = () => undefined;
      try {
        await wrap(ctx, fsWriteRequest("proxy/secret.txt"), next);
      } finally {
        console.warn = origWarn;
      }
      // Passthrough means next() ran but no snapshot was taken; tool would
      // run unprotected. The guard's purpose is to refuse to mutate files
      // beyond the workspace via rollback — passthrough is the safe choice.
      expect(nextRan).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  test("refuses to snapshot a symlink (unsupported_kind)", async () => {
    const erroring: FsSeam = {
      async read() {
        return {
          existed: true,
          bytes: new Uint8Array(),
          stat: { mtimeMs: 1, size: 0, ino: 1, kind: "symlink" },
        };
      },
      async stat() {
        return { mtimeMs: 1, size: 0, ino: 1, kind: "symlink" };
      },
      async write() {
        /* must not run */
      },
      async atomicWrite() {
        /* test stub */
      },
      async unlink() {
        /* must not run */
      },
    };
    const wrap = createFsRollbackMiddleware({ fs: erroring, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    // let: tracks whether next() ran — must remain false.
    let nextRan = false;
    const next = async (): Promise<ToolResponse> => {
      nextRan = true;
      return { output: "ok" };
    };
    try {
      await wrap(ctx, fsWriteRequest(), next);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const err = e as { readonly code?: string; readonly context?: { readonly reason?: string } };
      expect(err.code).toBe("INTERNAL");
      expect(err.context?.reason).toBe("unsupported_kind");
    }
    expect(nextRan).toBe(false);
  });

  test("concurrent unlink+recreate (different inode) surfaces conflict", async () => {
    // let: ino changes between snapshot read and rollback re-stat.
    let currentIno = 1;
    const seam: FsSeam = {
      async read() {
        return {
          existed: true,
          bytes: enc("PRE"),
          stat: { mtimeMs: 1, size: 3, ino: currentIno, kind: "file" },
        };
      },
      async stat() {
        return { mtimeMs: 99, size: 999, ino: currentIno, kind: "file" };
      },
      async write() {
        /* must not run on conflict */
      },
      async atomicWrite() {
        /* must not run on conflict */
      },
      async unlink() {
        /* must not run */
      },
    };
    const wrap = createFsRollbackMiddleware({ fs: seam, cwd: CWD }).middleware.wrapToolCall;
    if (!wrap) throw new Error();
    const next = async (): Promise<ToolResponse> => {
      currentIno = 999; // simulate concurrent unlink+recreate
      throw new Error("inner");
    };
    try {
      await wrap(ctx, fsWriteRequest(), next);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const err = e as { readonly code?: string; readonly context?: { readonly reason?: string } };
      expect(err.code).toBe("INTERNAL");
      expect(err.context?.reason).toBe("conflict");
    }
  });

  test("parent-symlink swap during tool call: rollback refuses (conflict)", async () => {
    // Real-fs scenario: snapshot succeeds with parent inside cwd. During
    // next(), the protected tool replaces the parent dir with a symlink
    // pointing outside cwd. Rollback's TOCTOU re-check must catch this
    // and refuse to write through to the external location.
    const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const outside = mkdtempSync(join(tmpdir(), "koi-fsrb-toctou-out-"));
    const ws = mkdtempSync(join(tmpdir(), "koi-fsrb-toctou-ws-"));
    try {
      mkdirSync(join(ws, "sub"));
      writeFileSync(join(ws, "sub", "f.txt"), "PRE");

      const handle = createFsRollbackMiddleware({ cwd: ws });
      const wrap = handle.middleware.wrapToolCall;
      if (!wrap) throw new Error();

      const next = async (): Promise<ToolResponse> => {
        // Replace `sub` with a symlink to `outside`.
        rmSync(join(ws, "sub"), { recursive: true, force: true });
        symlinkSync(outside, join(ws, "sub"));
        // Place a victim file that rollback must NOT touch.
        writeFileSync(join(outside, "f.txt"), "VICTIM");
        throw new Error("crash");
      };

      try {
        await wrap(ctx, fsWriteRequest("sub/f.txt", "toctou"), next);
        throw new Error("should have thrown");
      } catch (e: unknown) {
        // Either the original "crash" rethrown after a refused rollback,
        // or the conflict error directly. Either way the victim must survive.
        const err = e as {
          readonly message?: string;
          readonly context?: { readonly reason?: string };
        };
        const ok = err.message === "crash" || err.context?.reason === "conflict";
        expect(ok).toBe(true);
      }

      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(outside, "f.txt"), "utf8")).toBe("VICTIM");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("binary file roundtrip — random bytes survive snapshot/restore", async (): Promise<void> => {
    // Real-fs smoke test: a 256-byte file with every byte value, mutated
    // by the failing tool, must come back exactly after rollback.
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "koi-fs-rollback-bin-"));
    try {
      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) original[i] = i;
      const filePath = join(dir, "blob.bin");
      writeFileSync(filePath, original);

      const handle = createFsRollbackMiddleware({ cwd: dir });
      const wrap = handle.middleware.wrapToolCall;
      if (!wrap) throw new Error();

      const next = async (): Promise<ToolResponse> => {
        const corrupted = new Uint8Array(256);
        for (let i = 0; i < 256; i++) corrupted[i] = (i + 17) & 0xff;
        writeFileSync(filePath, corrupted);
        throw new Error("crash mid-write");
      };
      await expect(wrap(ctx, fsWriteRequest("blob.bin", "binary-call"), next)).rejects.toThrow();

      const restored = readFileSync(filePath);
      expect(restored.length).toBe(256);
      // let: track byte-mismatch index for diagnostic
      let mismatchAt = -1;
      for (let i = 0; i < 256; i++) {
        if (restored[i] !== original[i]) {
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
