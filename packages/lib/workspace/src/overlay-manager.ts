import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { KoiError, Result, WorkspaceId } from "@koi/core";
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

function parsePorcelainPaths(output: string): readonly string[] {
  if (output.length === 0) return [];
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const paths = entries.flatMap((entry, index, all) => {
    const status = entry.slice(0, 2);
    if (status[0] === "R" || status[0] === "C") {
      const sourcePath = entry[2] === " " ? entry.slice(3) : entry.slice(2);
      const renamedTo = all[index + 1];
      if (renamedTo === undefined) return [];
      return status[0] === "R" ? [sourcePath, renamedTo] : [renamedTo];
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
  return { ok: true, value: result.value.split("\n").filter(Boolean).sort() };
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
  await cp(source, destination, { force: true, preserveTimestamps: true, recursive: true });
}

class GitWorktreeOverlayManagerImpl implements GitWorktreeOverlayManager {
  private readonly registry = new Map<WorkspaceId, OverlayEntry>();
  private readonly basePath: string;
  private readonly config: GitWorktreeOverlayManagerConfig;

  constructor(config: GitWorktreeOverlayManagerConfig) {
    this.config = config;
    this.basePath = resolveWorktreeBasePath(config.repoPath, config.overlayBasePath);
    const resolvedRepo = resolve(config.repoPath);
    const resolvedBase = resolve(this.basePath);
    if (resolvedBase === resolvedRepo || resolvedBase.startsWith(resolvedRepo + sep)) {
      throw new Error(
        `overlayBasePath must not be inside the repository: ${resolvedBase} is under ${resolvedRepo}`,
      );
    }
  }

  async create(): Promise<Result<WorkspaceOverlay, KoiError>> {
    const createdAt = Date.now();
    const id = workspaceId(`overlay-${createdAt}-${Math.random().toString(36).slice(2)}`);
    const baseCommitResult = await runGit(["rev-parse", "HEAD"], this.config.repoPath);
    if (!baseCommitResult.ok) return baseCommitResult;
    const branchName = `overlay/${id}`;
    const path = join(this.basePath, id);
    const prepared = await this.prepareBasePath();
    if (!prepared.ok) return prepared;
    const addResult = await runGit(
      ["worktree", "add", "-b", branchName, path, baseCommitResult.value],
      this.config.repoPath,
    );
    if (!addResult.ok) return addResult;
    const overlay = this.createEntry(id, path, baseCommitResult.value, createdAt, branchName);
    this.registry.set(id, { overlay, branchName });
    return { ok: true, value: overlay };
  }

  async accept(id: WorkspaceId): Promise<Result<OverlayAcceptResult, KoiError>> {
    const entry = this.registry.get(id);
    if (entry === undefined) return { ok: false, error: notFoundError(id) };
    const overlayChanges = await changedPathsSinceBase(
      entry.overlay.path,
      entry.overlay.baseCommit,
    );
    if (!overlayChanges.ok) return overlayChanges;
    const repoChanges = await changedPathsSinceBase(this.config.repoPath, entry.overlay.baseCommit);
    if (!repoChanges.ok) return repoChanges;
    const conflicts = intersect(overlayChanges.value, repoChanges.value);
    if (conflicts.length > 0) return { ok: false, error: conflictError(conflicts) };
    const copied = await this.copyChanges(entry, overlayChanges.value);
    if (!copied.ok) return copied;
    const cleanupResult = await this.cleanup(entry);
    if (!cleanupResult.ok) return cleanupResult;
    return { ok: true, value: { changedPaths: overlayChanges.value } };
  }

  async reject(id: WorkspaceId): Promise<Result<void, KoiError>> {
    const entry = this.registry.get(id);
    if (entry === undefined) return { ok: false, error: notFoundError(id) };
    return this.cleanup(entry);
  }

  private async prepareBasePath(): Promise<Result<void, KoiError>> {
    try {
      await mkdir(this.basePath, { recursive: true });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: externalError(`Failed to create ${this.basePath}: ${message}`, e),
      };
    }
  }

  private createEntry(
    id: WorkspaceId,
    path: string,
    baseCommit: string,
    createdAt: number,
    branchName: string,
  ): WorkspaceOverlay {
    return {
      id,
      path,
      baseCommit,
      createdAt,
      metadata: { baseCommit, branchName, repoPath: this.config.repoPath },
    };
  }

  private async copyChanges(
    entry: OverlayEntry,
    paths: readonly string[],
  ): Promise<Result<void, KoiError>> {
    try {
      await Promise.all(
        paths.map((relativePath) =>
          copyOverlayPath(entry.overlay.path, this.config.repoPath, relativePath),
        ),
      );
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: externalError(`Failed to copy overlay changes: ${message}`, e) };
    }
  }

  private async cleanup(entry: OverlayEntry): Promise<Result<void, KoiError>> {
    const removed = await runGit(
      ["worktree", "remove", "--force", entry.overlay.path],
      this.config.repoPath,
    );
    if (!removed.ok) return removed;
    await runGit(["branch", "-D", entry.branchName], this.config.repoPath);
    this.registry.delete(entry.overlay.id);
    return { ok: true, value: undefined };
  }
}

export function createGitWorktreeOverlayManager(
  config: GitWorktreeOverlayManagerConfig,
): GitWorktreeOverlayManager {
  return new GitWorktreeOverlayManagerImpl(config);
}
