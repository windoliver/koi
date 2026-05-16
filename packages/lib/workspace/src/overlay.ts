import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileRenameResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
  WorkspaceId,
} from "@koi/core";
import { workspaceId } from "@koi/core";
import { resolveWorktreeBasePath, runGit } from "@koi/git-utils";

export interface GitWorktreeOverlayManagerConfig {
  readonly repoPath: string;
  readonly overlayBasePath?: string;
}

export interface WorkspaceOverlay {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly baseCommit: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface OverlayAcceptResult {
  readonly changedPaths: readonly string[];
}

export interface GitWorktreeOverlayManager {
  readonly create: () => Promise<Result<WorkspaceOverlay, KoiError>>;
  readonly accept: (id: WorkspaceId) => Promise<Result<OverlayAcceptResult, KoiError>>;
  readonly reject: (id: WorkspaceId) => Promise<Result<void, KoiError>>;
}

export interface OverlayFileSystemConfig {
  readonly real: FileSystemBackend;
  readonly overlay: FileSystemBackend;
}

interface OverlayEntry {
  readonly overlay: WorkspaceOverlay;
  readonly branchName: string;
}

function externalError(message: string, cause?: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message,
    retryable: false,
    ...(cause !== undefined ? { cause } : {}),
  };
}

function conflictError(conflictPaths: readonly string[]): KoiError {
  return {
    code: "CONFLICT",
    message: `Overlay accept would overwrite real workspace changes: ${conflictPaths.join(", ")}`,
    retryable: false,
    context: { conflictPaths },
  };
}

function notFoundError(id: WorkspaceId): KoiError {
  return {
    code: "NOT_FOUND",
    message: `Overlay ${id} not found`,
    retryable: false,
  };
}

function fileNotFoundError(path: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: `File not found: ${path}`,
    retryable: false,
  };
}

function parsePorcelainPaths(output: string): readonly string[] {
  if (output.length === 0) return [];
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const paths = entries.flatMap((entry, index, all) => {
    const status = entry.slice(0, 2);
    if (status[0] === "R" || status[0] === "C") {
      const renamedTo = all[index + 1];
      return renamedTo === undefined ? [] : [renamedTo];
    }
    if (index > 0) {
      const previousStatus = all[index - 1]?.slice(0, 2);
      if (previousStatus?.[0] === "R" || previousStatus?.[0] === "C") return [];
    }
    return [entry[2] === " " ? entry.slice(3) : entry.slice(2)];
  });
  return [...new Set(paths)].sort();
}

async function statusPaths(cwd: string): Promise<Result<readonly string[], KoiError>> {
  const result = await runGit(["status", "--porcelain", "-z"], cwd);
  if (!result.ok) return result;
  return { ok: true, value: parsePorcelainPaths(result.value) };
}

async function diffPaths(
  cwd: string,
  baseCommit: string,
): Promise<Result<readonly string[], KoiError>> {
  const result = await runGit(["diff", "--name-only", `${baseCommit}..HEAD`], cwd);
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.value
      .split("\n")
      .filter((path) => path.length > 0)
      .sort(),
  };
}

async function changedPathsSinceBase(
  cwd: string,
  baseCommit: string,
): Promise<Result<readonly string[], KoiError>> {
  const [diff, status] = await Promise.all([diffPaths(cwd, baseCommit), statusPaths(cwd)]);
  if (!diff.ok) return diff;
  if (!status.ok) return status;
  return { ok: true, value: [...new Set([...diff.value, ...status.value])].sort() };
}

function intersect(left: readonly string[], right: readonly string[]): readonly string[] {
  return left.filter((leftPath) =>
    right.some(
      (rightPath) =>
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`),
    ),
  );
}

async function copyOverlayPath(
  overlayRoot: string,
  repoRoot: string,
  relativePath: string,
): Promise<void> {
  const source = join(overlayRoot, relativePath);
  const destination = join(repoRoot, relativePath);
  if (!(await Bun.file(source).exists())) {
    await rm(destination, { recursive: true, force: true });
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    force: true,
    preserveTimestamps: true,
    recursive: true,
  });
}

export function createOverlayFileSystem(config: OverlayFileSystemConfig): FileSystemBackend {
  const tombstones = new Set<string>();
  const overlayPaths = new Set<string>();
  const overlay = config.overlay;
  const real = config.real;

  function isMaskedRealPath(path: string): boolean {
    return tombstones.has(path) || overlayPaths.has(path);
  }

  function computeDryRunEdit(
    path: string,
    content: string,
    edits: readonly FileEdit[],
  ): FileEditResult {
    let text = content;
    let applied = 0;
    for (const edit of edits) {
      if (!text.includes(edit.oldText)) continue;
      text = text.replace(edit.oldText, edit.newText);
      applied++;
    }
    return { path, hunksApplied: applied };
  }

  async function readOverlayOrReal(
    path: string,
    options?: FileReadOptions,
  ): Promise<Result<FileReadResult, KoiError>> {
    if (tombstones.has(path)) return { ok: false, error: fileNotFoundError(path) };
    const overlayResult = await overlay.read(path, options);
    if (overlayResult.ok || overlayResult.error.code !== "NOT_FOUND") return overlayResult;
    return real.read(path, options);
  }

  async function hydrateForEdit(path: string): Promise<Result<void, KoiError>> {
    const existing = await readOverlayOrReal(path);
    if (!existing.ok) return existing;
    const written = await overlay.write(path, existing.value.content, { createDirectories: true });
    if (!written.ok) return written;
    tombstones.delete(path);
    return { ok: true, value: undefined };
  }

  const backend: FileSystemBackend = {
    name: `${overlay.name}-overlay`,

    read: readOverlayOrReal,

    async write(
      path: string,
      content: string,
      options?: FileWriteOptions,
    ): Promise<Result<FileWriteResult, KoiError>> {
      tombstones.delete(path);
      const written = await overlay.write(path, content, options);
      if (written.ok) overlayPaths.add(path);
      return written;
    },

    async edit(
      path: string,
      edits: readonly FileEdit[],
      options?: FileEditOptions,
    ): Promise<Result<FileEditResult, KoiError>> {
      if (!tombstones.has(path)) {
        const overlayAttempt = await overlay.edit(path, edits, options);
        if (overlayAttempt.ok) {
          if (options?.dryRun !== true) overlayPaths.add(path);
          return overlayAttempt;
        }
        if (overlayAttempt.error.code !== "NOT_FOUND") return overlayAttempt;
      }
      if (options?.dryRun === true) {
        const existing = await readOverlayOrReal(path);
        if (!existing.ok) return existing;
        return { ok: true, value: computeDryRunEdit(path, existing.value.content, edits) };
      }
      const hydrated = await hydrateForEdit(path);
      if (!hydrated.ok) return hydrated;
      const edited = await overlay.edit(path, edits, options);
      if (edited.ok) overlayPaths.add(path);
      return edited;
    },

    async list(path, options): Promise<Result<FileListResult, KoiError>> {
      const [realList, overlayList] = await Promise.all([
        real.list(path, options),
        overlay.list(path, options),
      ]);
      if (!realList.ok && realList.error.code !== "NOT_FOUND") return realList;
      if (!overlayList.ok && overlayList.error.code !== "NOT_FOUND") return overlayList;
      const entries = new Map(
        (realList.ok ? realList.value.entries : [])
          .filter((entry) => !isMaskedRealPath(entry.path))
          .map((entry) => [entry.path, entry]),
      );
      for (const entry of overlayList.ok ? overlayList.value.entries : []) {
        if (!tombstones.has(entry.path)) entries.set(entry.path, entry);
      }
      return {
        ok: true,
        value: {
          entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
          truncated:
            (realList.ok ? realList.value.truncated : false) ||
            (overlayList.ok ? overlayList.value.truncated : false),
        },
      };
    },

    async search(pattern, options): Promise<Result<FileSearchResult, KoiError>> {
      const [realSearch, overlaySearch] = await Promise.all([
        real.search(pattern, options),
        overlay.search(pattern, options),
      ]);
      if (!realSearch.ok && realSearch.error.code !== "NOT_FOUND") return realSearch;
      if (!overlaySearch.ok && overlaySearch.error.code !== "NOT_FOUND") return overlaySearch;
      return {
        ok: true,
        value: {
          matches: [
            ...(realSearch.ok
              ? realSearch.value.matches.filter((match) => !isMaskedRealPath(match.path))
              : []),
            ...(overlaySearch.ok
              ? overlaySearch.value.matches.filter((match) => !tombstones.has(match.path))
              : []),
          ].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
          truncated:
            (realSearch.ok ? realSearch.value.truncated : false) ||
            (overlaySearch.ok ? overlaySearch.value.truncated : false),
        },
      };
    },

    async dispose(): Promise<void> {
      await overlay.dispose?.();
    },
  };

  if (overlay.delete === undefined) return backend;

  return {
    ...backend,

    async delete(path: string): Promise<Result<{ readonly path: string }, KoiError>> {
      tombstones.add(path);
      overlayPaths.delete(path);
      const deleted = await overlay.delete?.(path);
      if (deleted === undefined || deleted.ok || deleted.error.code === "NOT_FOUND") {
        return { ok: true, value: { path } };
      }
      return deleted;
    },

    async rename(from: string, to: string): Promise<Result<FileRenameResult, KoiError>> {
      const source = await readOverlayOrReal(from);
      if (!source.ok) return source;
      const written = await overlay.write(to, source.value.content, { createDirectories: true });
      if (!written.ok) return written;
      const deleted = await overlay.delete?.(from);
      if (deleted !== undefined && !deleted.ok && deleted.error.code !== "NOT_FOUND") {
        return deleted;
      }
      tombstones.delete(to);
      tombstones.add(from);
      overlayPaths.add(to);
      overlayPaths.delete(from);
      return { ok: true, value: { from, to } };
    },
  };
}

export function createGitWorktreeOverlayManager(
  config: GitWorktreeOverlayManagerConfig,
): GitWorktreeOverlayManager {
  const registry = new Map<WorkspaceId, OverlayEntry>();
  const basePath = resolveWorktreeBasePath(config.repoPath, config.overlayBasePath);
  const resolvedRepo = resolve(config.repoPath);
  const resolvedBase = resolve(basePath);

  if (resolvedBase === resolvedRepo || resolvedBase.startsWith(resolvedRepo + sep)) {
    throw new Error(
      `overlayBasePath must not be inside the repository: ${resolvedBase} is under ${resolvedRepo}`,
    );
  }

  async function cleanup(entry: OverlayEntry): Promise<Result<void, KoiError>> {
    const removeResult = await runGit(
      ["worktree", "remove", "--force", entry.overlay.path],
      config.repoPath,
    );
    if (!removeResult.ok) return removeResult;
    await runGit(["branch", "-D", entry.branchName], config.repoPath);
    registry.delete(entry.overlay.id);
    return { ok: true, value: undefined };
  }

  return {
    async create(): Promise<Result<WorkspaceOverlay, KoiError>> {
      const createdAt = Date.now();
      const id = workspaceId(`overlay-${createdAt}-${Math.random().toString(36).slice(2)}`);
      const baseCommitResult = await runGit(["rev-parse", "HEAD"], config.repoPath);
      if (!baseCommitResult.ok) return baseCommitResult;

      const branchName = `overlay/${id}`;
      const path = join(basePath, id);
      try {
        await mkdir(basePath, { recursive: true });
      } catch (e: unknown) {
        return {
          ok: false,
          error: externalError(
            `Failed to create overlay base directory ${basePath}: ${e instanceof Error ? e.message : String(e)}`,
            e,
          ),
        };
      }

      const addResult = await runGit(
        ["worktree", "add", "-b", branchName, path, baseCommitResult.value],
        config.repoPath,
      );
      if (!addResult.ok) return addResult;

      const overlay: WorkspaceOverlay = {
        id,
        path,
        baseCommit: baseCommitResult.value,
        createdAt,
        metadata: {
          baseCommit: baseCommitResult.value,
          branchName,
          repoPath: config.repoPath,
        },
      };
      registry.set(id, { overlay, branchName });
      return { ok: true, value: overlay };
    },

    async accept(id: WorkspaceId): Promise<Result<OverlayAcceptResult, KoiError>> {
      const entry = registry.get(id);
      if (entry === undefined) return { ok: false, error: notFoundError(id) };

      const overlayChanges = await changedPathsSinceBase(
        entry.overlay.path,
        entry.overlay.baseCommit,
      );
      if (!overlayChanges.ok) return overlayChanges;
      const repoChanges = await changedPathsSinceBase(config.repoPath, entry.overlay.baseCommit);
      if (!repoChanges.ok) return repoChanges;

      const conflicts = intersect(overlayChanges.value, repoChanges.value);
      if (conflicts.length > 0) return { ok: false, error: conflictError(conflicts) };

      try {
        await Promise.all(
          overlayChanges.value.map((relativePath) =>
            copyOverlayPath(entry.overlay.path, config.repoPath, relativePath),
          ),
        );
      } catch (e: unknown) {
        return {
          ok: false,
          error: externalError(
            `Failed to copy overlay changes into repository: ${e instanceof Error ? e.message : String(e)}`,
            e,
          ),
        };
      }

      const cleanupResult = await cleanup(entry);
      if (!cleanupResult.ok) return cleanupResult;
      return { ok: true, value: { changedPaths: overlayChanges.value } };
    },

    async reject(id: WorkspaceId): Promise<Result<void, KoiError>> {
      const entry = registry.get(id);
      if (entry === undefined) return { ok: false, error: notFoundError(id) };
      return cleanup(entry);
    },
  };
}
