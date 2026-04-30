import { createHash } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvalRun, EvalRunMeta, EvalStore } from "./types.js";

export function createFsStore(rootDir: string): EvalStore {
  return {
    save: async (run, options): Promise<void> => {
      // Validate at write time so a buggy caller cannot poison a suite —
      // findLatestStrict() fails closed on any corrupt artifact, so an
      // unvalidated save would brick baseline lookup until manual cleanup.
      assertSavable(run);
      const filePath = pathFor(rootDir, run.name, run.id);
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(tempPath, serializeRun(run), "utf8");
      try {
        if (options?.overwrite === true) {
          // Overwrite path: rename is atomic and replaces destination.
          await rename(tempPath, filePath);
          return;
        }
        // Atomic create-or-fail: link() does NOT replace an existing
        // destination, so concurrent writers cannot both succeed. Use
        // EEXIST to surface collisions deterministically. This is safe
        // under POSIX concurrency; Windows behaves equivalently for
        // hardlinks on NTFS.
        try {
          await link(tempPath, filePath);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
              `EvalStore: run "${run.id}" already exists for suite "${run.name}" — pass { overwrite: true } to replace`,
            );
          }
          throw e;
        }
      } finally {
        // Always unlink the staged temp file: in the link path it's a
        // duplicate; in the rename path it's already moved (unlink is a
        // no-op then). Best-effort.
        await unlink(tempPath).catch(() => {});
      }
    },
    load: async (runId: string, evalName?: string): Promise<EvalRun | undefined> => {
      assertSafeComponent(runId, "runId");
      if (evalName !== undefined) {
        return await readRunStrict(pathFor(rootDir, evalName, runId), runId, evalName);
      }
      const matches = await findAllRunFiles(rootDir, runId);
      // Reject ambiguous lookups — caller must scope by evalName when ids
      // may collide across suites. Returning the first match would be
      // dependent on directory enumeration order.
      if (matches.length !== 1) return undefined;
      const path = matches[0];
      return path === undefined ? undefined : await readRunStrict(path, runId);
    },
    latest: async (evalName: string): Promise<EvalRun | undefined> => {
      assertSafeComponent(evalName, "evalName");
      return findLatestStrict(rootDir, evalName);
    },
    list: async (evalName: string): Promise<readonly EvalRunMeta[]> => {
      assertSafeComponent(evalName, "evalName");
      return listMetas(rootDir, evalName);
    },
  };
}

/**
 * Serialize a run defensively. Tool results and custom-event data carry
 * `unknown` payloads, so a stray BigInt, host object, or circular structure
 * could otherwise blow up `JSON.stringify` after a full eval run — losing
 * the baseline. We sanitize unsupported leaves into a structured marker.
 */
const WRAPPED = "__koiEvalWrapped";
const UNSERIALIZABLE = "__koiEvalUnserializable";
const ESCAPED = "__koiEvalEscaped";

function serializeRun(run: EvalRun): string {
  // Active recursion stack. WeakSet kept entries forever and so flagged
  // legitimate DAG aliasing — `{a: shared, b: shared}` — as a circular
  // reference, silently corrupting tool-output payloads on save. We
  // remove the entry on unwind so only true back-references trigger.
  const stack = new Set<object>();
  const sanitize = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "bigint") return { [UNSERIALIZABLE]: "bigint", repr: value.toString() };
    if (t === "function" || t === "symbol") return { [UNSERIALIZABLE]: t };
    if (t !== "object") return value;
    const obj = value as object;
    // Reversibly encode common host objects — silently degrading them to
    // {} would lose debugging information that the persisted transcript
    // is supposed to preserve.
    if (value instanceof Date) return { [WRAPPED]: "date", iso: value.toISOString() };
    if (value instanceof URL) return { [WRAPPED]: "url", href: value.href };
    if (value instanceof RegExp) {
      return { [WRAPPED]: "regexp", source: value.source, flags: value.flags };
    }
    if (value instanceof Map) {
      return {
        [WRAPPED]: "map",
        entries: [...value.entries()].map(([k, v]) => [sanitize(k), sanitize(v)]),
      };
    }
    if (value instanceof Set) {
      return { [WRAPPED]: "set", values: [...value.values()].map(sanitize) };
    }
    if (stack.has(obj)) return { [UNSERIALIZABLE]: "circular" };
    stack.add(obj);
    try {
      if (Array.isArray(value)) return value.map(sanitize);
      // Plain object or unknown class instance: enumerable keys only. Mark
      // unknown class instances so they're not silently flattened to {}.
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        return {
          [UNSERIALIZABLE]: "non-plain-object",
          constructor: (obj as { constructor?: { name?: string } }).constructor?.name ?? "unknown",
        };
      }
      // Escape user objects that happen to contain our reserved markers,
      // so revive() does not reinterpret them as store-owned wrappers and
      // mutate the round-tripped payload (e.g. user data with a literal
      // `__koiEvalWrapped: "url"` key would otherwise come back as a URL).
      const userObj = value as Record<string, unknown>;
      if (WRAPPED in userObj || UNSERIALIZABLE in userObj || ESCAPED in userObj) {
        const inner: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(userObj)) inner[k] = sanitize(v);
        return { [ESCAPED]: true, value: inner };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(userObj)) out[k] = sanitize(v);
      return out;
    } finally {
      stack.delete(obj);
    }
  };
  return JSON.stringify(sanitize(run), null, 2);
}

/**
 * Reverse of serializeRun's __wrapped encoding: turn `{__wrapped: "date", iso}`
 * back into a Date, etc. Wrapper objects that don't match a known shape
 * are passed through unchanged. `__unserializable` markers are left as-is
 * — they represent values that genuinely could not be serialized
 * (functions/symbols/cycles), and the consumer can inspect the marker
 * for debugging.
 */
function revive(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(revive);
  const obj = value as Record<string, unknown>;
  // Escape envelope first: user data that originally contained a reserved
  // marker key was wrapped at serialize time. Unwrap before any wrapper
  // dispatch so the original keys are preserved.
  if (obj[ESCAPED] === true && obj.value !== null && typeof obj.value === "object") {
    // Escape envelope: the inner object is the user's original payload
    // verbatim (already containing reserved marker keys). Revive its
    // child values normally, but do NOT re-dispatch the top-level keys
    // through the wrapper switch — those marker keys are user data.
    const inner = obj.value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inner)) out[k] = revive(v);
    return out;
  }
  const wrapped = obj[WRAPPED];
  if (typeof wrapped === "string") {
    switch (wrapped) {
      case "date":
        return typeof obj.iso === "string" ? new Date(obj.iso) : obj;
      case "url":
        return typeof obj.href === "string" ? new URL(obj.href) : obj;
      case "regexp":
        return typeof obj.source === "string" && typeof obj.flags === "string"
          ? new RegExp(obj.source, obj.flags)
          : obj;
      case "map": {
        if (!Array.isArray(obj.entries)) return obj;
        const m = new Map<unknown, unknown>();
        for (const e of obj.entries) {
          if (Array.isArray(e) && e.length === 2) m.set(revive(e[0]), revive(e[1]));
        }
        return m;
      }
      case "set": {
        if (!Array.isArray(obj.values)) return obj;
        return new Set(obj.values.map(revive));
      }
      default:
        return obj;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = revive(v);
  return out;
}

function pathFor(rootDir: string, evalName: string, runId: string): string {
  assertSafeComponent(evalName, "evalName");
  assertSafeComponent(runId, "runId");
  return join(rootDir, encode(evalName), `${encode(runId)}.json`);
}

/**
 * Reject path-traversal components. encodeURIComponent does not escape
 * "." or ".." so we must guard them explicitly to keep operations inside
 * rootDir.
 */
function assertSafeComponent(value: string, what: string): void {
  if (value.length === 0) throw new Error(`EvalStore: ${what} must be non-empty`);
  // encodeURIComponent escapes "/", "\" etc. but does NOT escape "." or
  // ".." — those remain literal and would resolve outside rootDir via
  // path.join. Block them explicitly. NUL bytes are also blocked because
  // POSIX path APIs treat them as terminators.
  if (value === "." || value === "..") {
    throw new Error(`EvalStore: ${what} "${value}" is not allowed`);
  }
  if (value.includes("\0")) {
    throw new Error(`EvalStore: ${what} contains a NUL byte`);
  }
}

// encodeURIComponent guarantees a one-to-one, collision-free mapping from
// arbitrary strings to safe path components. Decode mirrors it for listing.
function encode(s: string): string {
  return encodeURIComponent(s);
}

type ReadResult =
  | { readonly kind: "ok"; readonly run: EvalRun }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupted"; readonly path: string; readonly cause: unknown };

async function readRunResult(
  path: string,
  expectedId?: string,
  expectedName?: string,
): Promise<ReadResult> {
  let run: EvalRun;
  try {
    const text = await readFile(path, "utf8");
    const parsed = revive(JSON.parse(text) as unknown);
    if (!isEvalRunShape(parsed)) return { kind: "corrupted", path, cause: "shape mismatch" };
    run = parsed;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "corrupted", path, cause: e };
  }
  if (expectedId !== undefined && run.id !== expectedId) {
    return {
      kind: "corrupted",
      path,
      cause: `id mismatch (file: ${run.id}, expected: ${expectedId})`,
    };
  }
  if (expectedName !== undefined && run.name !== expectedName) {
    return {
      kind: "corrupted",
      path,
      cause: `name mismatch (file: ${run.name}, suite directory: ${expectedName})`,
    };
  }
  // Range checks: tampered files could declare arbitrary numeric values.
  if (
    run.summary.passRate < 0 ||
    run.summary.passRate > 1 ||
    run.summary.meanScore < 0 ||
    !Number.isFinite(run.summary.meanScore)
  ) {
    return { kind: "corrupted", path, cause: "summary out of range" };
  }
  // Cross-check stored summary against trials. A mismatch means either
  // the file was hand-edited or trials/summary were written from
  // different states — either way we cannot trust the persisted
  // summary for regression decisions.
  const recomputed = recomputeSummaryAggregates(run);
  if (!aggregatesMatch(recomputed, run.summary)) {
    return {
      kind: "corrupted",
      path,
      cause: "summary does not match trials",
    };
  }
  // Suite integrity: stored summary must reflect the configured task set
  // exactly once. A tampered file with a duplicated `byTask.taskId`
  // (one row hides another's failures) or a mismatched
  // config.taskCount/summary.taskCount (whole tasks omitted from the
  // run) would otherwise feed compareRuns a partial picture.
  const suiteDrift = checkSuiteIntegrity(run);
  if (suiteDrift !== undefined) {
    return { kind: "corrupted", path, cause: suiteDrift };
  }
  // Cancellation/abort consistency: compareRuns relies on these fields
  // to fail closed on leaked teardown. A run rewritten to strip an
  // `aborted` flag or set every trial to `n/a` when one was actually
  // unconfirmed must be rejected — otherwise the regression gate
  // accepts an incompletely-isolated run as a clean baseline.
  const cancellationDrift = checkCancellationConsistency(run);
  if (cancellationDrift !== undefined) {
    return { kind: "corrupted", path, cause: cancellationDrift };
  }
  // Per-task fingerprint integrity: stored taskFingerprint must equal
  // SHA-256 of stored taskSpec. A run rewritten to swap fingerprints
  // without touching the spec (so compareRuns sees a "matching"
  // baseline for a drifted task) is rejected here.
  for (const t of run.summary.byTask) {
    const expected = createHash("sha256").update(t.taskSpec).digest("hex");
    if (expected !== t.taskFingerprint) {
      return {
        kind: "corrupted",
        path,
        cause: `taskFingerprint mismatch for taskId "${t.taskId}"`,
      };
    }
  }
  return { kind: "ok", run };
}

function checkSuiteIntegrity(run: EvalRun): string | undefined {
  const ids = run.summary.byTask.map((b) => b.taskId);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    return "summary.byTask has duplicate taskId entries";
  }
  if (run.config.taskCount !== run.summary.taskCount) {
    return `config.taskCount (${run.config.taskCount}) does not match summary.taskCount (${run.summary.taskCount})`;
  }
  // Every trial must reference a task that the configured suite knows
  // about — otherwise a smuggled trial could skew aggregates.
  for (const t of run.trials) {
    if (!unique.has(t.taskId)) {
      return `trial taskId "${t.taskId}" is not present in summary.byTask`;
    }
  }
  return undefined;
}

function checkCancellationConsistency(run: EvalRun): string | undefined {
  const hasUnconfirmed = run.trials.some((t) => t.cancellation === "unconfirmed");
  if (hasUnconfirmed && run.aborted !== true) {
    return "trial reports cancellation 'unconfirmed' but run is not marked aborted";
  }
  if (run.aborted === true && run.abortReason === "cancellation_unconfirmed" && !hasUnconfirmed) {
    return "run claims cancellation_unconfirmed abort but no trial has 'unconfirmed' cancellation";
  }
  return undefined;
}

interface PerTask {
  readonly trials: number;
  readonly passRate: number;
  readonly meanScore: number;
}

interface Aggregates {
  readonly trialCount: number;
  readonly passRate: number;
  readonly errorCount: number;
  readonly meanScore: number;
  readonly byTaskId: ReadonlyMap<string, PerTask>;
}

function recomputeSummaryAggregates(run: EvalRun): Aggregates {
  const trialCount = run.trials.length;
  let passed = 0;
  let errors = 0;
  let scoreSum = 0;
  const groups = new Map<string, EvalRun["trials"][number][]>();
  for (const t of run.trials) {
    if (t.status === "pass") passed += 1;
    else if (t.status === "error") errors += 1;
    scoreSum += trialScore(t);
    const arr = groups.get(t.taskId) ?? [];
    arr.push(t);
    groups.set(t.taskId, arr);
  }
  const byTaskId = new Map<string, PerTask>();
  for (const [id, ts] of groups) {
    const tPassed = ts.filter((x) => x.status === "pass").length;
    const tScoreSum = ts.reduce((acc, x) => acc + trialScore(x), 0);
    byTaskId.set(id, {
      trials: ts.length,
      passRate: ts.length === 0 ? 0 : tPassed / ts.length,
      meanScore: ts.length === 0 ? 0 : tScoreSum / ts.length,
    });
  }
  return {
    trialCount,
    passRate: trialCount === 0 ? 0 : passed / trialCount,
    errorCount: errors,
    meanScore: trialCount === 0 ? 0 : scoreSum / trialCount,
    byTaskId,
  };
}

function trialScore(t: EvalRun["trials"][number]): number {
  if (t.scores.length === 0) return 0;
  let s = 0;
  for (const sc of t.scores) s += sc.score;
  return s / t.scores.length;
}

const FLOAT_SLACK = 1e-9;

function aggregatesMatch(recomputed: Aggregates, stored: EvalRun["summary"]): boolean {
  if (recomputed.trialCount !== stored.trialCount) return false;
  if (recomputed.errorCount !== stored.errorCount) return false;
  if (Math.abs(recomputed.passRate - stored.passRate) > FLOAT_SLACK) return false;
  if (Math.abs(recomputed.meanScore - stored.meanScore) > FLOAT_SLACK) return false;
  // taskCount must equal byTask length (the runner always emits one entry
  // per configured task).
  if (stored.taskCount !== stored.byTask.length) return false;
  // Every distinct taskId in trials must appear in stored byTask, and the
  // recomputed per-task aggregates must match the stored values. Extra
  // byTask rows with zero trials are allowed (a task with no trials run).
  const storedById = new Map(stored.byTask.map((b) => [b.taskId, b]));
  for (const [id, recomputedTask] of recomputed.byTaskId) {
    const s = storedById.get(id);
    if (s === undefined) return false;
    if (s.trials !== recomputedTask.trials) return false;
    if (Math.abs(s.passRate - recomputedTask.passRate) > FLOAT_SLACK) return false;
    if (Math.abs(s.meanScore - recomputedTask.meanScore) > FLOAT_SLACK) return false;
  }
  for (const s of stored.byTask) {
    const recomputedTask = recomputed.byTaskId.get(s.taskId);
    if (recomputedTask === undefined) {
      // Stored entry without trials must be the canonical zero-row —
      // a tampered file claiming perfect scores for an unrun task
      // would otherwise feed fake numbers into compareRuns.
      if (s.trials !== 0) return false;
      if (Math.abs(s.passRate) > FLOAT_SLACK) return false;
      if (Math.abs(s.meanScore) > FLOAT_SLACK) return false;
    }
  }
  return true;
}

/**
 * Wrapper for callers that want only `EvalRun | undefined` and accept
 * silent corruption (used by listMetas/latest, where one bad file cannot
 * be allowed to blind the whole history).
 */
async function readRun(path: string, expectedId?: string): Promise<EvalRun | undefined> {
  const r = await readRunResult(path, expectedId);
  return r.kind === "ok" ? r.run : undefined;
}

/**
 * Strict variant for explicit load() calls: returns undefined for true
 * not-found, but throws for corruption so the regression gate fails
 * closed instead of silently degrading to "no_baseline".
 */
async function readRunStrict(
  path: string,
  expectedId?: string,
  expectedName?: string,
): Promise<EvalRun | undefined> {
  const r = await readRunResult(path, expectedId, expectedName);
  if (r.kind === "ok") return r.run;
  if (r.kind === "missing") return undefined;
  throw new Error(
    `EvalStore: corrupted run file at ${r.path} — ${r.cause instanceof Error ? r.cause.message : String(r.cause)}`,
    { cause: r.cause instanceof Error ? r.cause : undefined },
  );
}

function assertSavable(run: EvalRun): void {
  if (!isEvalRunShape(run)) {
    throw new Error("EvalStore.save: run does not match EvalRun schema");
  }
  const recomputed = recomputeSummaryAggregates(run);
  if (!aggregatesMatch(recomputed, run.summary)) {
    throw new Error(
      "EvalStore.save: summary does not match trials — refusing to persist inconsistent run",
    );
  }
  for (const t of run.summary.byTask) {
    const expected = createHash("sha256").update(t.taskSpec).digest("hex");
    if (expected !== t.taskFingerprint) {
      throw new Error(
        `EvalStore.save: taskFingerprint does not match taskSpec for taskId "${t.taskId}"`,
      );
    }
  }
  const suiteDrift = checkSuiteIntegrity(run);
  if (suiteDrift !== undefined) {
    throw new Error(`EvalStore.save: ${suiteDrift}`);
  }
  const drift = checkCancellationConsistency(run);
  if (drift !== undefined) {
    throw new Error(`EvalStore.save: ${drift}`);
  }
}

function isCanonicalIsoTimestamp(s: string): boolean {
  // Only accept the exact format produced by Date.prototype.toISOString:
  // YYYY-MM-DDTHH:MM:SS.sssZ. Round-tripping rejects "garbage", far-future
  // strings that don't normalize, leap-second variants, etc.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return false;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString() === s;
}

function isEvalRunShape(v: unknown): v is EvalRun {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string") return false;
  if (typeof r.name !== "string") return false;
  if (typeof r.timestamp !== "string") return false;
  // Strict ISO-8601 (round-trip via Date.toISOString). Rejects anything
  // that wouldn't have been produced by the runner — prevents hand-edited
  // far-future timestamps from poisoning latest() baseline selection.
  if (!isCanonicalIsoTimestamp(r.timestamp)) return false;
  if (!Array.isArray(r.trials)) return false;
  for (const t of r.trials as readonly unknown[]) {
    if (!isTrialShape(t)) return false;
  }
  if (!isConfigSnapshot(r.config)) return false;
  if (!isSummary(r.summary)) return false;
  return true;
}

function isTrialShape(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (typeof t.taskId !== "string") return false;
  if (typeof t.trialIndex !== "number") return false;
  if (!Array.isArray(t.transcript)) return false;
  if (!Array.isArray(t.scores)) return false;
  for (const s of t.scores as readonly unknown[]) {
    if (s === null || typeof s !== "object") return false;
    const sc = s as Record<string, unknown>;
    if (typeof sc.graderId !== "string") return false;
    if (typeof sc.score !== "number") return false;
    if (typeof sc.pass !== "boolean") return false;
  }
  if (t.metrics === null || typeof t.metrics !== "object") return false;
  const m = t.metrics as Record<string, unknown>;
  if (typeof m.totalTokens !== "number") return false;
  if (typeof m.durationMs !== "number") return false;
  if (t.status !== "pass" && t.status !== "fail" && t.status !== "error") return false;
  if (
    t.cancellation !== "n/a" &&
    t.cancellation !== "confirmed" &&
    t.cancellation !== "unconfirmed"
  ) {
    return false;
  }
  return true;
}

function isConfigSnapshot(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.name === "string" &&
    typeof c.timeoutMs === "number" &&
    typeof c.passThreshold === "number" &&
    typeof c.taskCount === "number"
  );
}

function isSummary(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s.taskCount !== "number") return false;
  if (typeof s.trialCount !== "number") return false;
  if (typeof s.passRate !== "number") return false;
  if (typeof s.meanScore !== "number") return false;
  if (typeof s.errorCount !== "number") return false;
  if (!Array.isArray(s.byTask)) return false;
  for (const t of s.byTask as readonly unknown[]) {
    if (t === null || typeof t !== "object") return false;
    const ts = t as Record<string, unknown>;
    if (typeof ts.taskId !== "string") return false;
    if (typeof ts.taskName !== "string") return false;
    if (typeof ts.passRate !== "number") return false;
    if (typeof ts.meanScore !== "number") return false;
    if (typeof ts.trials !== "number") return false;
    if (typeof ts.taskFingerprint !== "string") return false;
    if (typeof ts.taskSpec !== "string") return false;
  }
  return true;
}

async function findLatestStrict(rootDir: string, evalName: string): Promise<EvalRun | undefined> {
  const dir = join(rootDir, encode(evalName));
  // Final files end in `.json`. Temp files we write end in `.json.tmp-...`,
  // which already fails endsWith(".json") — no extra substring filter needed.
  // (Filtering by .includes(".tmp-") would mistakenly hide real run IDs that
  // happen to contain ".tmp-".)
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return undefined;

  // Fail closed on ANY corrupt artifact in the suite. We cannot trust mtime
  // to bound corruption (clock skew, copy/extract preserving older mtime,
  // intentional touch) and a corrupt file with the newest logical
  // run.timestamp could otherwise be silently demoted to an older baseline.
  // Latest() is the regression-gate path — surfacing store damage is more
  // important than answering at all.
  const ok: EvalRun[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const r = await readRunResult(path, undefined, evalName);
    if (r.kind === "ok") ok.push(r.run);
    else if (r.kind === "corrupted") {
      throw new Error(
        `EvalStore: corrupted run file at ${r.path} — refusing to choose a baseline while the suite contains damaged artifacts`,
        { cause: r.cause instanceof Error ? r.cause : undefined },
      );
    }
  }

  // Pick the newest valid run by run.timestamp.
  ok.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return ok[0];
}

async function findAllRunFiles(rootDir: string, runId: string): Promise<readonly string[]> {
  const encoded = `${encode(runId)}.json`;
  const dirs = await safeReaddir(rootDir);
  const found: string[] = [];
  for (const evalName of dirs) {
    const path = join(rootDir, evalName, encoded);
    if (await fileExists(path)) found.push(path);
  }
  return found;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Permission errors, transient I/O failures, and other filesystem
    // problems must propagate so unscoped baseline discovery fails closed
    // instead of silently returning `undefined` from load(runId).
    throw e;
  }
}

async function listMetas(rootDir: string, evalName: string): Promise<readonly EvalRunMeta[]> {
  const dir = join(rootDir, encode(evalName));
  // Final files end in `.json`. Temp files we write end in `.json.tmp-...`,
  // which already fails endsWith(".json") — no extra substring filter needed.
  // (Filtering by .includes(".tmp-") would mistakenly hide real run IDs that
  // happen to contain ".tmp-".)
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith(".json"));
  const metas: EvalRunMeta[] = [];
  for (const f of files) {
    const run = await readRun(join(dir, f));
    if (run === undefined) continue;
    metas.push({
      id: run.id,
      name: run.name,
      timestamp: run.timestamp,
      passRate: run.summary.passRate,
      taskCount: run.summary.taskCount,
    });
  }
  metas.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return metas;
}

async function safeReaddir(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (e: unknown) {
    // Only suppress true not-found — propagate permission/IO errors so
    // callers can fail closed instead of silently degrading to "no
    // baseline" against a broken store.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
