/**
 * Plan-persist file backend — owns the in-process mirror, the disk
 * layout, and all I/O. The middleware in plan-persist-middleware.ts
 * adapts this backend to `wrapToolCall` for the koi_plan_save and
 * koi_plan_load tools.
 */

import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { KoiRuntimeError } from "@koi/errors";
import {
  DEFAULT_BASE_DIR,
  type PlanPersistConfig,
  type PlanPersistFs,
  validatePlanPersistConfig,
} from "./config.js";
import {
  generatePlanMarkdown,
  generateSlug,
  generateTimestamp,
  parsePlanMarkdown,
  validateSlug,
} from "./format.js";
import { resolveBaseDir, resolveSafePath } from "./path-safety.js";
import type { OnPlanUpdate, PlanItem } from "./types.js";

/** In-process mirror of the most recent plan committed for a given session. */
interface PlanMirror {
  readonly items: readonly PlanItem[];
  readonly epoch: number;
  readonly turnIndex: number;
  readonly generatedAt: number;
}

export interface PlanPersistBackend {
  /** Pass to `createPlanMiddleware({ onPlanUpdate })`. */
  readonly onPlanUpdate: OnPlanUpdate;
  /** Diagnostic accessor for the in-process mirror. */
  readonly getActivePlan: (sessionId: string) => readonly PlanItem[] | undefined;
  /** Save the latest mirrored plan for `sessionId` to disk under an optional slug. */
  readonly savePlan: (sessionId: string, slug?: string) => Promise<SavePlanResult>;
  /** Load and parse a plan file. */
  readonly loadPlan: (path: string) => Promise<LoadPlanResult>;
  /** Drop the mirror entry for a session (e.g., onSessionEnd). */
  readonly dropSession: (sessionId: string) => void;
  /** Absolute path to the resolved plans directory. */
  readonly baseDir: string;
}

export type SavePlanResult =
  | { readonly ok: true; readonly path: string; readonly items: readonly PlanItem[] }
  | { readonly ok: false; readonly error: string };

export type LoadPlanResult =
  | { readonly ok: true; readonly path: string; readonly items: readonly PlanItem[] }
  | { readonly ok: false; readonly error: string };

const MAX_FILENAME_COLLISION_ATTEMPTS = 10;

/**
 * Build a plan-persist file backend. Throws synchronously when `baseDir`
 * resolves outside `cwd` (a misconfiguration the host cannot recover from
 * at runtime).
 */
export function createPlanPersistBackend(config?: PlanPersistConfig): PlanPersistBackend {
  const validated = validatePlanPersistConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }
  const cwd = validated.value.cwd ?? process.cwd();
  const baseDirInput = validated.value.baseDir ?? DEFAULT_BASE_DIR;

  const resolvedBase = resolveBaseDir(baseDirInput, cwd);
  if (!resolvedBase.ok) {
    throw KoiRuntimeError.from("VALIDATION", resolvedBase.error);
  }
  const baseDir = resolvedBase.path;

  const fs: PlanPersistFs = validated.value.fs ?? defaultFs();
  const now = validated.value.now ?? Date.now;
  const rand = validated.value.rand ?? Math.random;

  const mirrors = new Map<string, PlanMirror>();

  // Lazy-resolved canonical baseDir. macOS aliases /tmp -> /private/tmp via
  // a symlink; realpath of any saved file under baseDir returns the
  // canonical form while baseDir itself is still the user-supplied value.
  // Without canonicalizing both sides we'd incorrectly reject legitimate
  // saved files at load time. Cached after the first ensure-and-realpath.
  // let justified: single-slot lazy cache for the canonical baseDir
  let baseDirRealCache: string | undefined;
  const ensureBaseDirReal = async (): Promise<string> => {
    if (baseDirRealCache !== undefined) return baseDirRealCache;
    await fs.mkdir(baseDir, { recursive: true });
    baseDirRealCache = await fs.realpath(baseDir);
    return baseDirRealCache;
  };

  const onPlanUpdate: OnPlanUpdate = (plan, ctx) => {
    if (ctx.signal.aborted) return;
    mirrors.set(ctx.sessionId, {
      items: plan,
      epoch: ctx.epoch,
      turnIndex: ctx.turnIndex,
      generatedAt: now(),
    });
  };

  const savePlan = async (sessionId: string, slug?: string): Promise<SavePlanResult> => {
    const mirror = mirrors.get(sessionId);
    if (mirror === undefined) {
      return { ok: false, error: "no plan to save" };
    }
    const slugResult = resolveSlug(slug, rand);
    if (!slugResult.ok) return slugResult;

    await ensureBaseDirReal();

    const ts = generateTimestamp(new Date(mirror.generatedAt));
    const md = generatePlanMarkdown(mirror.items, {
      generated: new Date(mirror.generatedAt).toISOString(),
      sessionId,
      epoch: mirror.epoch,
      turnIndex: mirror.turnIndex,
    });

    const finalPath = await pickAvailablePath(baseDir, ts, slugResult.slug, fs);
    if (!finalPath.ok) return finalPath;

    await atomicWrite(finalPath.path, md, fs, rand);
    return { ok: true, path: finalPath.path, items: mirror.items };
  };

  const loadPlan = async (path: string): Promise<LoadPlanResult> => {
    const baseDirReal = await ensureBaseDirReal();
    const safe = await resolveSafePath(path, baseDir, baseDirReal, cwd, fs);
    if (!safe.ok) return safe;
    let source: string;
    try {
      source = await fs.readFile(safe.path, "utf8");
    } catch (_e: unknown) {
      return { ok: false, error: "file not found" };
    }
    const parsed = parsePlanMarkdown(source);
    if (!parsed.ok) {
      return { ok: false, error: `invalid plan format: ${parsed.error}` };
    }
    return { ok: true, path: safe.path, items: parsed.items };
  };

  const getActivePlan = (sessionId: string): readonly PlanItem[] | undefined =>
    mirrors.get(sessionId)?.items;

  const dropSession = (sessionId: string): void => {
    mirrors.delete(sessionId);
  };

  return { onPlanUpdate, getActivePlan, savePlan, loadPlan, dropSession, baseDir };
}

function resolveSlug(
  slug: string | undefined,
  rand: () => number,
): { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly error: string } {
  if (slug === undefined) {
    return { ok: true, slug: generateSlug(rand) };
  }
  return validateSlug(slug);
}

async function pickAvailablePath(
  baseDir: string,
  ts: string,
  slug: string,
  fs: PlanPersistFs,
): Promise<
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }
> {
  for (let i = 0; i <= MAX_FILENAME_COLLISION_ATTEMPTS; i++) {
    const suffix = i === 0 ? "" : `-${String(i)}`;
    const candidate = join(baseDir, `${ts}-${slug}${suffix}.md`);
    const exists = await fileExists(candidate, fs);
    if (!exists) return { ok: true, path: candidate };
  }
  return { ok: false, error: "filename collision" };
}

async function fileExists(path: string, fs: PlanPersistFs): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (_e: unknown) {
    return false;
  }
}

async function atomicWrite(
  finalPath: string,
  data: string,
  fs: PlanPersistFs,
  rand: () => number,
): Promise<void> {
  const tmp = `${finalPath}.tmp.${String(process.pid)}.${String(Math.floor(rand() * 1e9))}`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, finalPath);
  } catch (e: unknown) {
    try {
      await fs.unlink(tmp);
    } catch (_unlinkErr: unknown) {
      // Ignore — temp file may not exist if writeFile failed first.
    }
    throw e;
  }
}

function defaultFs(): PlanPersistFs {
  return {
    mkdir: (path, opts): Promise<unknown> => nodeFs.mkdir(path, opts),
    writeFile: (path, data): Promise<void> => nodeFs.writeFile(path, data),
    readFile: (path, encoding): Promise<string> => nodeFs.readFile(path, encoding),
    rename: (a, b): Promise<void> => nodeFs.rename(a, b),
    stat: (path): Promise<unknown> => nodeFs.stat(path),
    realpath: (path): Promise<string> => nodeFs.realpath(path),
    unlink: (path): Promise<void> => nodeFs.unlink(path),
  };
}
