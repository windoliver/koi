/**
 * Filesystem rollback middleware factory.
 *
 * Snapshots the bytes of the single target file before a protected tool
 * call. On failure, restores those bytes (or unlinks for the new-file
 * case). Touches only `request.input.path`.
 *
 * Scope and limitations:
 *   - Protected tools MUST mutate at most the single file at
 *     `request.input.path`. Tools that touch multiple files (e.g. `Bash`)
 *     are out of scope and will leave partial state on failure.
 *   - **In-process single-writer assumption.** This middleware assumes the
 *     protected tool is the only writer of the target file during its
 *     execution. Same-inode concurrent writes (an IDE save, another
 *     process editing in place) cannot be distinguished from the tool's
 *     own write — the restore-on-failure path will overwrite the
 *     concurrent change. We reject the cases we *can* detect (kind change,
 *     unlink+recreate via different inode), but cross-process locking is
 *     out of scope for this package; callers must add their own lock if
 *     external concurrency is realistic.
 *   - Containment is anchored to `cwd` (with realpath resolution to defeat
 *     parent-symlink escapes). Protected calls whose target resolves
 *     outside `cwd` pass through unprotected; this is a deliberate scope
 *     choice — to extend protection across nested workspaces, configure
 *     `cwd` to the broader root.
 *   - Snapshot read failures (EACCES, EMFILE, ...) cause the call to fail
 *     closed with an INTERNAL error rather than running the tool unprotected.
 *   - Symlinks, directories, and other non-regular files at the target
 *     path are rejected at snapshot time with `unsupported_kind`.
 *
 * Priority 180 — innermost of `@koi/middleware-tool-error-formatter` (170)
 * so rollback restores BEFORE the formatter wraps the throw for the model.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { FsReadResult, FsRollbackConfig, FsRollbackHandle, FsSeam, FsStat } from "./types.js";

const DEFAULT_PROTECTED_TOOLS: readonly string[] = ["fs_write", "fs_edit"] as const;

function classifyKind(s: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}): FsStat["kind"] {
  if (s.isSymbolicLink()) return "symlink";
  if (s.isFile()) return "file";
  if (s.isDirectory()) return "dir";
  return "other";
}

const defaultFs: FsSeam = {
  async read(path: string): Promise<FsReadResult> {
    const { readFile, lstat } = await import("node:fs/promises");
    try {
      // lstat first so a symlink path snapshots as kind:"symlink" and
      // restore can refuse rather than write through to the link target.
      const s = await lstat(path);
      const kind = classifyKind(s);
      const stat: FsStat = { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino, kind };
      // Only read bytes for regular files. Symlinks/dirs/etc. are
      // returned as existed:true with empty bytes; restore will refuse
      // to clobber them.
      const bytes = kind === "file" ? new Uint8Array(await readFile(path)) : new Uint8Array();
      return { existed: true, bytes, stat };
    } catch (e: unknown) {
      const code = (e as { readonly code?: string }).code;
      if (code === "ENOENT") return { existed: false };
      throw e;
    }
  },
  async stat(path: string): Promise<FsStat | undefined> {
    const { lstat } = await import("node:fs/promises");
    try {
      const s = await lstat(path);
      return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino, kind: classifyKind(s) };
    } catch (e: unknown) {
      if ((e as { readonly code?: string }).code === "ENOENT") return undefined;
      throw e;
    }
  },
  async write(path: string, bytes: Uint8Array): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    const { open, mkdir, rename, unlink } = await import("node:fs/promises");
    const { dirname, basename } = await import("node:path");
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    // Sibling temp file in the same directory so `rename` is atomic
    // (cross-device rename is not). Crypto-random suffix avoids
    // collisions with concurrent middleware instances.
    const { randomBytes } = await import("node:crypto");
    const suffix = randomBytes(6).toString("hex");
    const tmpPath = `${dir}/.${basename(path)}.koi-fsrb-${suffix}`;
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, path);
    } catch (e: unknown) {
      // Clean up temp file if rename failed; rethrow original.
      try {
        await unlink(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
  },
  async unlink(path: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(path);
    } catch (e: unknown) {
      if ((e as { readonly code?: string }).code === "ENOENT") return;
      throw e;
    }
  },
};

interface Snapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes: Uint8Array | undefined;
  readonly stat: FsStat | undefined;
}

/**
 * Treat a `ToolResponse` as a failure when:
 *   - hook explicitly blocked it (`metadata.blockedByHook === true`), or
 *   - the tool exposed an `exitCode` and it is non-zero.
 */
function isFailingResponse(response: ToolResponse): boolean {
  const meta = response.metadata;
  if (meta === undefined) return false;
  if (meta.blockedByHook === true) return true;
  const exitCode = meta.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

function extractPath(input: ToolRequest["input"]): string | undefined {
  const p = input.path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

type RollbackReason = "snapshot_failed" | "restore_failed" | "conflict" | "unsupported_kind";

function rollbackError(path: string, reason: RollbackReason, cause?: unknown): Error {
  const messages: Record<RollbackReason, string> = {
    snapshot_failed: `fs-rollback: cannot snapshot ${path}; refusing to run protected tool.`,
    restore_failed: `fs-rollback: failed to restore ${path}. Recover manually from a backup.`,
    conflict: `fs-rollback: refusing to restore ${path} — file was replaced or its type changed since snapshot.`,
    unsupported_kind: `fs-rollback: ${path} is not a regular file (symlink/dir/other); rollback unavailable.`,
  };
  return Object.assign(new Error(messages[reason], cause === undefined ? {} : { cause }), {
    code: "INTERNAL",
    retryable: false,
    context: { path, reason },
    internal: true,
  });
}

export function createFsRollbackMiddleware(config?: FsRollbackConfig): FsRollbackHandle {
  const protectedTools = new Set<string>(config?.protectedTools ?? DEFAULT_PROTECTED_TOOLS);
  const cwd = config?.cwd ?? process.cwd();
  const fs: FsSeam = config?.fs ?? defaultFs;
  // let: one-shot warning when a protected call targets a path outside
  // `cwd`. Without this, callers cannot observe that protection was
  // silently skipped — issued at most once per middleware instance.
  let outOfScopeWarned = false;

  const capabilityFragment: CapabilityFragment = {
    label: "fs-rollback",
    description: "Snapshot/restore target file around protected tool calls",
  };

  async function takeSnapshot(absPath: string): Promise<Snapshot> {
    const r = await fs.read(absPath);
    if (r.existed && r.stat.kind !== "file") {
      // Refuse to snapshot symlinks/dirs/other — restore semantics for
      // those are surprising (writeFile through a symlink writes to the
      // target outside the workspace; unlink of a dir fails).
      throw rollbackError(absPath, "unsupported_kind");
    }
    return {
      path: absPath,
      existed: r.existed,
      bytes: r.existed ? r.bytes : undefined,
      stat: r.existed ? r.stat : undefined,
    };
  }

  async function restoreSnapshot(snapshot: Snapshot, realCwd: string): Promise<void> {
    // TOCTOU defense: re-validate containment at rollback time. A
    // protected tool can replace a parent dir with a symlink mid-call;
    // without this re-check, fs.write/unlink would follow the new symlink
    // and mutate files outside the workspace.
    const { realpath } = await import("node:fs/promises");
    const { dirname, basename, relative, isAbsolute } = await import("node:path");
    // let: realpath the parent at rollback time; if it no longer resolves
    // inside cwd, the parent was replaced or symlinked elsewhere.
    let realParent: string;
    try {
      realParent = await realpath(dirname(snapshot.path));
    } catch {
      realParent = dirname(snapshot.path);
    }
    const realResolved = `${realParent}/${basename(snapshot.path)}`;
    const rel = relative(realCwd, realResolved);
    if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
      throw rollbackError(snapshot.path, "conflict");
    }
    // Re-stat to detect concurrent unlink+recreate (different ino) or
    // a kind change (regular file → symlink). These would mean another
    // writer raced us, so we fail closed rather than clobber their write.
    const current = await fs.stat(snapshot.path);
    if (snapshot.existed) {
      if (current === undefined) {
        // Tool deleted the file before failing. Recreate it.
        await fs.atomicWrite(snapshot.path, snapshot.bytes ?? new Uint8Array());
        return;
      }
      if (current.kind !== "file") {
        throw rollbackError(snapshot.path, "conflict");
      }
      if (snapshot.stat !== undefined && current.ino !== snapshot.stat.ino) {
        // File was unlinked and recreated by someone else — different
        // inode means we're not looking at our original file anymore.
        throw rollbackError(snapshot.path, "conflict");
      }
      await fs.atomicWrite(snapshot.path, snapshot.bytes ?? new Uint8Array());
    } else {
      if (current === undefined) {
        // Tool didn't actually create the file (or already cleaned up).
        return;
      }
      if (current.kind !== "file") {
        // A symlink or dir appeared at this path — not the partial write
        // we'd unlink. Refuse.
        throw rollbackError(snapshot.path, "conflict");
      }
      await fs.unlink(snapshot.path);
    }
  }

  const middleware: KoiMiddleware = {
    name: "fs-rollback",
    priority: 180,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!protectedTools.has(request.toolId)) return next(request);

      const raw = extractPath(request.input);
      if (raw === undefined) return next(request);

      const { resolve, relative, isAbsolute, dirname, basename } = await import("node:path");
      const { realpath } = await import("node:fs/promises");
      const absPath = resolve(cwd, raw);
      // Containment guard: realpath both the workspace root and the
      // target's parent directory before comparing. A pure lexical check
      // would miss a symlinked parent (e.g. `cwd/proxy/file.txt` where
      // `cwd/proxy` symlinks to `/etc`). With realpath, any parent
      // symlink that escapes the workspace makes the relative check fail.
      // let: real paths resolved via fs realpath; fall back to lexical
      // when the path doesn't exist yet (new file creation).
      let realCwd: string;
      let realTargetParent: string;
      try {
        realCwd = await realpath(cwd);
      } catch {
        realCwd = cwd;
      }
      try {
        realTargetParent = await realpath(dirname(absPath));
      } catch {
        // Parent doesn't exist yet — fall back to lexical resolution.
        realTargetParent = dirname(absPath);
      }
      const realAbsPath = `${realTargetParent}/${basename(absPath)}`;
      const rel = relative(realCwd, realAbsPath);
      if (rel.length === 0) return next(request);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        if (!outOfScopeWarned) {
          outOfScopeWarned = true;
          // eslint-disable-next-line no-console -- one-shot operator warning
          console.warn(
            `[@koi/middleware-fs-rollback] protected tool ${request.toolId} targeted ${absPath} outside rollback scope (${cwd}); call is unprotected. Configure cwd to a broader root to extend coverage.`,
          );
        }
        return next(request);
      }

      // Fail closed on read errors (other than ENOENT — that's "new file"
      // and produces a snapshot with existed=false). Silent passthrough
      // would turn a "protected" write into an unprotected one with no
      // signal to the caller.
      // let: snapshot may throw on EACCES / EMFILE / unsupported kind.
      let snapshot: Snapshot;
      try {
        snapshot = await takeSnapshot(absPath);
      } catch (readErr: unknown) {
        // If takeSnapshot already produced our typed error (e.g. unsupported_kind), pass it through.
        if ((readErr as { readonly internal?: boolean }).internal === true) throw readErr;
        throw rollbackError(absPath, "snapshot_failed", readErr);
      }

      // let: response captured on success path; toolError captured on throw.
      let response: ToolResponse | undefined;
      // let: thrown error from inner handler
      let toolError: unknown;
      try {
        response = await next(request);
      } catch (e: unknown) {
        toolError = e;
      }

      const failed =
        toolError !== undefined || (response !== undefined && isFailingResponse(response));

      if (!failed) return response as ToolResponse;

      try {
        await restoreSnapshot(snapshot, realCwd);
      } catch (rollbackErr: unknown) {
        if ((rollbackErr as { readonly internal?: boolean }).internal === true) throw rollbackErr;
        throw rollbackError(snapshot.path, "restore_failed", rollbackErr);
      }
      if (toolError !== undefined) throw toolError;
      return response as ToolResponse;
    },
  };

  return { middleware };
}
