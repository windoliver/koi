/**
 * Filesystem rollback middleware factory.
 *
 * Snapshots the working tree before a protected tool call via
 * `git stash push --include-untracked --message <token>`, then either
 * `git stash drop <ref>` on success or `git stash pop <ref>` on failure.
 * The token is unique per call so concurrent sessions can't pop each
 * other's entries.
 *
 * Priority 180 — innermost of `@koi/middleware-tool-error-formatter` (170)
 * so rollback restores BEFORE the formatter wraps the throw for the model.
 */

import type {
  CapabilityFragment,
  KoiError,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { runGit as runGitDefault } from "@koi/git-utils";
import type { FsRollbackConfig, FsRollbackHandle, RunGitFn, RunGitOutcome } from "./types.js";

const DEFAULT_PROTECTED_TOOLS: readonly string[] = ["fs_write", "fs_edit"] as const;

/**
 * Default seam — bridges `@koi/git-utils.runGit` (Result<string, KoiError>)
 * to the seam interface (ok/stdout/stderr). Production code uses this; tests
 * inject a mock instead.
 */
const defaultRunGit: RunGitFn = async (
  args: readonly string[],
  cwd: string,
): Promise<RunGitOutcome> => {
  const result = await runGitDefault(args, cwd);
  if (result.ok) return { ok: true, stdout: result.value, stderr: "" };
  return { ok: false, stdout: "", stderr: result.error.message };
};

/**
 * Resolve the git root from `cwd`. Returns `undefined` if not inside any
 * git repository — caller treats that as "no-op for the entire session".
 */
async function resolveGitRoot(runGit: RunGitFn, cwd: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!result.ok) return undefined;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True when `path` (after normalization) resolves under `repoRoot`. Path
 * comparison uses `path.resolve` to handle relative paths and `..`
 * traversal. We don't need filesystem realpath — the working tree must
 * literally live under the resolved git root for stash to track it.
 */
/**
 * Best-effort realpath. Falls back to the input on failure (e.g. the path
 * doesn't exist yet — `fs_write` legitimately creates new files).
 */
async function realpathOr(p: string): Promise<string> {
  try {
    const { realpath } = await import("node:fs/promises");
    return await realpath(p);
  } catch {
    return p;
  }
}

async function isPathInsideRepo(filePath: string, repoRoot: string, cwd: string): Promise<boolean> {
  const { resolve, sep, relative, dirname } = await import("node:path");
  const resolvedRaw = resolve(cwd, filePath);
  // macOS quirk: tmpdir() returns `/var/folders/...` but `git rev-parse
  // --show-toplevel` resolves through the `/private` symlink. Without
  // realpath both ends, paths inside a temp git repo would appear to live
  // outside the resolved root. We realpath the parent (the file may not
  // exist yet for a fresh fs_write) and stitch the basename back on.
  const parentReal = await realpathOr(dirname(resolvedRaw));
  const { basename } = await import("node:path");
  const resolved = `${parentReal}${sep}${basename(resolvedRaw)}`;
  const rootReal = await realpathOr(repoRoot);
  const rel = relative(rootReal, resolved);
  if (rel.length === 0) return true;
  if (rel.startsWith("..")) return false;
  return !rel.startsWith(`..${sep}`);
}

/**
 * True when the working tree is clean for the file at `relPath` (no
 * pending changes that stash would capture). Detected via
 * `git status --porcelain -- <path>` — empty output means clean.
 */
async function isPathClean(runGit: RunGitFn, repoRoot: string, relPath: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain", "--", relPath], repoRoot);
  if (!result.ok) return false;
  return result.stdout.trim().length === 0;
}

/**
 * Treat a `ToolResponse` as a failure when:
 *   - hook explicitly blocked it (`metadata.blockedByHook === true`), or
 *   - the tool exposed an `exitCode` and it is non-zero.
 *
 * Tools that don't surface either signal succeed silently — we cannot
 * second-guess arbitrary tool semantics, only the ones the runtime has
 * stable conventions for.
 */
function isFailingResponse(response: ToolResponse): boolean {
  const meta = response.metadata;
  if (meta === undefined) return false;
  if (meta.blockedByHook === true) return true;
  const exitCode = meta.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  return false;
}

/**
 * Find the stash entry whose message contains our unique token and return
 * its `stash@{N}` ref. Returns `undefined` if not found (which would mean
 * either git stash dropped it under us, or the snapshot was a no-op for
 * a different reason).
 */
async function findStashRef(
  runGit: RunGitFn,
  repoRoot: string,
  token: string,
): Promise<string | undefined> {
  const result = await runGit(["stash", "list"], repoRoot);
  if (!result.ok) return undefined;
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(token)) continue;
    const match = line.match(/^(stash@\{\d+\})/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

interface CallSnapshot {
  readonly token: string;
  readonly ref: string;
}

async function takeSnapshot(
  runGit: RunGitFn,
  repoRoot: string,
  token: string,
): Promise<CallSnapshot | undefined> {
  const pushResult = await runGit(
    ["stash", "push", "--include-untracked", "--message", token],
    repoRoot,
  );
  if (!pushResult.ok) return undefined;
  // git stash push prints "No local changes to save" when the tree is
  // clean — defensive, since we already checked porcelain. Match either
  // explicit message OR an absent stash ref by re-listing.
  if (pushResult.stdout.includes("No local changes to save")) return undefined;
  const ref = await findStashRef(runGit, repoRoot, token);
  if (ref === undefined) return undefined;
  return { token, ref };
}

async function restoreSnapshot(
  runGit: RunGitFn,
  repoRoot: string,
  snapshot: CallSnapshot,
): Promise<KoiError | undefined> {
  // Re-resolve ref by token in case unrelated stash activity shifted indices.
  const ref = (await findStashRef(runGit, repoRoot, snapshot.token)) ?? snapshot.ref;
  // Discard any working-tree changes the failing tool made on top of HEAD
  // (stash push already reset to HEAD before the tool ran). This avoids
  // a 3-way merge conflict between the tool's partial write and the
  // stashed pre-call delta — the stash IS the truth, so we hard-reset
  // first and then apply it cleanly. Untracked files the tool created
  // are also wiped via `git clean -fd`.
  await runGit(["reset", "--hard", "HEAD"], repoRoot);
  await runGit(["clean", "-fd"], repoRoot);
  const popResult = await runGit(["stash", "pop", ref], repoRoot);
  if (popResult.ok) return undefined;
  return {
    code: "INTERNAL",
    message: `fs-rollback: failed to restore snapshot (stash pop conflict). Recover manually: git stash list | grep ${snapshot.token}; git stash apply <ref>.`,
    retryable: false,
    context: {
      stashRef: snapshot.token,
      gitStderr: popResult.stderr,
    },
  };
}

async function discardSnapshot(
  runGit: RunGitFn,
  repoRoot: string,
  snapshot: CallSnapshot,
): Promise<void> {
  const ref = (await findStashRef(runGit, repoRoot, snapshot.token)) ?? snapshot.ref;
  // Drop is best-effort: a failure here means the stash entry stays around
  // (visible via `git stash list`), but the working tree is correct. We
  // intentionally do not surface it as an error — that would convert a
  // successful tool call into a model-visible failure.
  await runGit(["stash", "drop", ref], repoRoot);
}

/**
 * Per-instance state holder. We resolve the git root lazily on first
 * protected tool call and cache the outcome. `noGitWarned` ensures the
 * "not inside a git repo" warning fires at most once per middleware
 * instance — quiet for non-git users.
 */
interface InstanceState {
  // let: resolved on first protected tool call, then cached. Sentinel
  // `null` distinguishes "checked, no repo" from "not yet checked".
  rootResolved: boolean;
  root: string | undefined;
  noGitWarned: boolean;
  callCounter: number;
}

export function createFsRollbackMiddleware(config?: FsRollbackConfig): FsRollbackHandle {
  const protectedTools = new Set<string>(config?.protectedTools ?? DEFAULT_PROTECTED_TOOLS);
  const cwd = config?.cwd ?? process.cwd();
  const runGit: RunGitFn = config?.runGit ?? defaultRunGit;

  const state: InstanceState = {
    rootResolved: false,
    root: undefined,
    noGitWarned: false,
    callCounter: 0,
  };

  async function ensureRoot(): Promise<string | undefined> {
    if (state.rootResolved) return state.root;
    state.root = await resolveGitRoot(runGit, cwd);
    state.rootResolved = true;
    if (state.root === undefined && !state.noGitWarned) {
      state.noGitWarned = true;
      // eslint-disable-next-line no-console -- one-shot operator warning
      console.warn(
        `[@koi/middleware-fs-rollback] cwd is not inside a git repository (${cwd}); rollback disabled for this session.`,
      );
    }
    return state.root;
  }

  function buildToken(ctx: TurnContext, request: ToolRequest): string {
    const sid = ctx.session.sessionId;
    const cid = request.callId ?? `n${state.callCounter}`;
    state.callCounter += 1;
    return `koi-fs-rollback:${sid}:${cid}:${state.callCounter}`;
  }

  async function shouldSnapshot(
    request: ToolRequest,
    repoRoot: string,
  ): Promise<{ readonly ok: true; readonly relPath: string } | { readonly ok: false }> {
    const filePath = request.input.path;
    if (typeof filePath !== "string" || filePath.length === 0) return { ok: false };
    const inside = await isPathInsideRepo(filePath, repoRoot, cwd);
    if (!inside) return { ok: false };
    const { resolve, relative, dirname, basename, sep } = await import("node:path");
    const resolvedRaw = resolve(cwd, filePath);
    const parentReal = await realpathOr(dirname(resolvedRaw));
    const rootReal = await realpathOr(repoRoot);
    const resolved = `${parentReal}${sep}${basename(resolvedRaw)}`;
    const relPath = relative(rootReal, resolved);
    if (await isPathClean(runGit, rootReal, relPath)) return { ok: false };
    return { ok: true, relPath };
  }

  const capabilityFragment: CapabilityFragment = {
    label: "fs-rollback",
    description: "Snapshot/restore working tree around protected tool calls",
  };

  const middleware: KoiMiddleware = {
    name: "fs-rollback",
    priority: 180,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!protectedTools.has(request.toolId)) return next(request);

      const root = await ensureRoot();
      if (root === undefined) return next(request);

      const decision = await shouldSnapshot(request, root);
      if (!decision.ok) return next(request);

      const token = buildToken(ctx, request);
      const snapshot = await takeSnapshot(runGit, root, token);

      // Guard: snapshot may have failed to register (e.g. concurrent stash
      // activity, race with file creation). Without a snapshot we cannot
      // promise rollback, so fall back to passthrough rather than offering
      // a false guarantee.
      if (snapshot === undefined) return next(request);

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

      if (failed) {
        const popError = await restoreSnapshot(runGit, root, snapshot);
        if (popError !== undefined) {
          // Pop conflict: the model recovering would not help (the tree is
          // already in an unknown state). Surface as an internal error so
          // the formatter (priority 170) lets it through.
          throw Object.assign(new Error(popError.message), {
            code: popError.code,
            retryable: popError.retryable,
            context: popError.context,
            internal: true,
          });
        }
        if (toolError !== undefined) throw toolError;
        // response is defined here because toolError === undefined
        return response as ToolResponse;
      }

      await discardSnapshot(runGit, root, snapshot);
      return response as ToolResponse;
    },
  };

  return { middleware };
}
