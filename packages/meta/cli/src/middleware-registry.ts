/**
 * Manifest middleware registry.
 *
 * Decouples `manifest.middleware` entry names from concrete factory
 * imports so hosts and plugins can add zone-B middleware without
 * reaching into `runtime-factory.ts`. Ported from v1's
 * `archive/v1/packages/meta/starter/src/builtin-registry.ts` pattern,
 * tightened so unknown names fail loudly instead of silently skipping.
 *
 * Scope: zone B is middleware-only. This registry intentionally CANNOT
 * contribute providers, hookExtras, exports, or lifecycle hooks — those
 * concerns live in `PresetStack` activation (see
 * `packages/meta/cli/src/preset-stacks.ts`). If a package needs to
 * contribute any of those, it stays stack-only and does not register
 * here.
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";
import type { KoiMiddleware, MiddlewarePhase } from "@koi/core";
import { createAuditMiddleware } from "@koi/middleware-audit";

/**
 * Closable audit sink as returned by `createNdjsonAuditSink`.
 * `@koi/core`'s `AuditSink` type does not include `close()`;
 * that's added by the NDJSON implementation and is what the
 * shared-sink cache needs to call on runtime dispose.
 */
type ClosableAuditSink = ReturnType<typeof createNdjsonAuditSink>;

import { CORE_MIDDLEWARE_BLOCKLIST, type ManifestMiddlewareEntry } from "./manifest.js";

/**
 * Thrown when a manifest middleware entry names a core middleware layer
 * that hosts configure via factory flags, not via `manifest.middleware`.
 * Runs in addition to the YAML-level check so programmatic callers of
 * `createKoiRuntime({ manifestMiddleware: [...] })` cannot bypass the
 * blocklist by skipping `loadManifestConfig`.
 */
export class CoreMiddlewareBlockedError extends Error {
  override readonly name = "CoreMiddlewareBlockedError";
  readonly blockedName: string;
  constructor(blockedName: string) {
    super(
      `manifest.middleware entry "${blockedName}" names a core middleware layer — ` +
        "configure it via host flags, not manifest content. " +
        `blocked names: ${CORE_MIDDLEWARE_BLOCKLIST.join(", ")}`,
    );
    this.blockedName = blockedName;
  }
}

/**
 * Forced phase + priority + concurrent mode for every resolved
 * zone-B middleware.
 *
 * The engine's `sortMiddlewareByPhase` orders middleware by tier
 * (intercept=0 < resolve=1 < observe=2) and then by ascending
 * priority within a tier. The real security / core layer ordering
 * after sort is:
 *
 *   exfiltration-guard  intercept  priority  50   (outermost)
 *   permissions         intercept  priority 100
 *   system-prompt       resolve    priority 100
 *   goal                resolve    priority 340
 *   hooks               resolve    priority 400
 *   model-router        resolve    priority 900
 *   session-transcript  observe    priority 200
 *   audit (stack)       observe    priority 300
 *   ──────────── zone B slot: observe / 500 (concurrent) ─────────────
 *
 * Zone B lands at `observe / 500` and is forced to run in
 * concurrent-observer mode (`concurrent: true`). This closes
 * the two competing requirements Codex flagged across rounds:
 *
 *   1. Zone B must not mutate trusted runtime layers. Concurrent
 *      observe-phase scheduling means `wrapModelCall` and
 *      `wrapToolCall` run IN PARALLEL with the next handler
 *      instead of wrapping it. The middleware sees the request
 *      and response but cannot rewrite what reaches the next
 *      layer — the engine already dispatched to the real next
 *      before the observer ran. Errors thrown by the observer
 *      are silently swallowed by the engine and do not
 *      propagate into the real chain.
 *
 *   2. Zone B must see the final provider-bound request. Observe
 *      tier runs AFTER every intercept and resolve layer, so by
 *      the time a zone-B observer is invoked the request has
 *      already passed through exfiltration-guard, permissions,
 *      system-prompt, goal, hooks, and model-router. Audit
 *      middleware now records the actual payload the provider
 *      received, not a pre-injection snapshot.
 *
 * Tradeoffs accepted:
 *   - `wrapModelStream` always runs sequentially regardless of
 *     `concurrent` (concurrent stream observation is not
 *     supported, per the engine's KoiMiddleware interface).
 *     Stream observers can still mutate. Today no built-in
 *     manifest middleware implements `wrapModelStream`, and the
 *     adapter wraps stream hooks through the same bind path so
 *     future entries inherit standard middleware semantics.
 *   - Intercept-phase hooks (`onSessionStart`, `onPermissionDecision`,
 *     etc.) are not affected by `concurrent` — those semantics
 *     are advisory only for the two wrap hooks.
 *
 * The value is forced so a manifest entry that declared a
 * different phase or priority cannot leapfrog either the security
 * guard above or the trusted runtime layers below.
 * `sortMiddlewareByPhase` runs after composition; the array order
 * in `composeRuntimeMiddleware` is irrelevant and the forced slot
 * here is the ONLY thing that matters.
 */
const ZONE_B_PHASE: MiddlewarePhase = "observe";
const ZONE_B_PRIORITY = 500;
const ZONE_B_CONCURRENT = true;

/**
 * Context passed to every manifest middleware factory. Intentionally
 * narrow: the factory gets enough to configure itself, but no access
 * to providers or runtime internals.
 *
 * `stackExports` carries the already-resolved early-phase stack
 * exports (bashHandle, trajectoryStore, etc.) so a manifest-registered
 * middleware can read a read-only view if it needs to, without
 * forcing every zone-B middleware to become a stack.
 *
 * `registerShutdown` lets a factory register a cleanup callback that
 * fires when the runtime is disposed. File-backed middleware like
 * `@koi/middleware-audit` opens a file writer at resolution time;
 * without a shutdown hook, the writer would leak its file descriptor
 * and flush timer across the runtime's lifetime. The runtime factory
 * calls every registered shutdown fn in reverse registration order
 * on `KoiRuntimeHandle.dispose()`, and also on post-resolution
 * assembly failure so partially constructed resources are unwound.
 */
export interface ManifestMiddlewareContext {
  readonly sessionId: string;
  readonly hostId: string;
  readonly workingDirectory: string;
  readonly stackExports: Readonly<Record<string, unknown>>;
  readonly registerShutdown: (fn: () => Promise<void> | void) => void;
  /**
   * Runtime-wide cache of already-opened file-backed sinks,
   * keyed by canonical absolute path. Audit (and any other
   * file-backed) factories check this cache before opening a
   * new writer so multiple resolve passes — parent + every
   * spawned child's re-resolution — share ONE writer per file
   * instead of opening independent writers that interleave into
   * the same NDJSON trail. Each child still gets its own
   * middleware instance (own queue, own lifecycle hooks), but
   * they all serialize through the cached sink.
   *
   * The cache's lifetime is the runtime handle; the first
   * resolver that opens a sink also registers the close() hook
   * with `registerShutdown`, and subsequent resolvers that
   * reuse the cached sink do NOT re-register the close hook.
   * `runtime.dispose()` closes each sink exactly once.
   */
  readonly sharedAuditSinks: Map<string, ClosableAuditSink>;
}

export type ManifestMiddlewareFactory = (
  entry: ManifestMiddlewareEntry,
  ctx: ManifestMiddlewareContext,
) => Promise<KoiMiddleware> | KoiMiddleware;

/**
 * Options for `MiddlewareRegistry.register`.
 */
export interface RegisterOptions {
  /**
   * When `true`, the resolver returns the factory's result verbatim
   * and does NOT wrap it in the zone-B `adaptToZoneBSlot` adapter.
   * Trusted registrations retain their native `phase`/`priority`
   * and can expose the full middleware interface including
   * `wrapModelStream`.
   *
   * Only set this for middleware whose source code is owned and
   * audited by the koi repo (i.e. built-ins registered from
   * `createBuiltinManifestRegistry`). Plugin or host registrations
   * of third-party middleware should leave this unset so the
   * zone-B adapter's concurrent-observer protection still applies.
   *
   * The trust boundary this flag relaxes is the "repo-authored
   * middleware code might mutate" concern — it does NOT relax the
   * "repo-authored manifest CONFIG might extract data" concern.
   * Trusted built-ins are still responsible for scrubbing their
   * own records (e.g. `@koi/middleware-audit` forces
   * `redactRequestBodies: true` at the factory level).
   */
  readonly trusted?: boolean;
}

interface RegistryEntry {
  readonly factory: ManifestMiddlewareFactory;
  readonly trusted: boolean;
}

/**
 * Mutable registry of name → factory. Registration is an
 * append-only operation in practice; duplicate registration of the
 * same name replaces the previous factory (plugins can override
 * built-ins explicitly if they want to).
 */
export class MiddlewareRegistry {
  readonly #entries = new Map<string, RegistryEntry>();

  register(name: string, factory: ManifestMiddlewareFactory, options?: RegisterOptions): void {
    this.#entries.set(name, { factory, trusted: options?.trusted === true });
  }

  get(name: string): ManifestMiddlewareFactory | undefined {
    return this.#entries.get(name)?.factory;
  }

  isTrusted(name: string): boolean {
    return this.#entries.get(name)?.trusted === true;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  names(): readonly string[] {
    return Array.from(this.#entries.keys()).sort();
  }
}

/**
 * Error thrown when `manifest.middleware` names a middleware that
 * is not registered. The error surfaces the full list of registered
 * names so users can spot typos or missing imports.
 */
export class UnknownManifestMiddlewareError extends Error {
  override readonly name = "UnknownManifestMiddlewareError";
  readonly requestedName: string;
  readonly registeredNames: readonly string[];
  constructor(requestedName: string, registeredNames: readonly string[]) {
    super(
      `unknown manifest middleware "${requestedName}" — registered names: ${
        registeredNames.length === 0 ? "(none)" : registeredNames.join(", ")
      }`,
    );
    this.requestedName = requestedName;
    this.registeredNames = registeredNames;
  }
}

/**
 * Resolve an ordered list of manifest middleware entries into
 * concrete `KoiMiddleware` instances. Preserves declared order and
 * drops entries with `enabled: false`.
 *
 * Throws `UnknownManifestMiddlewareError` on the first unknown name
 * rather than silently skipping (v1's behavior was to warn + skip,
 * which let typos ship unnoticed).
 */
export async function resolveManifestMiddleware(
  entries: readonly ManifestMiddlewareEntry[] | undefined,
  registry: MiddlewareRegistry,
  ctx: ManifestMiddlewareContext,
): Promise<readonly KoiMiddleware[]> {
  if (entries === undefined || entries.length === 0) {
    return [];
  }
  // Pre-resolution collision check for file-backed entries that
  // share a canonical target path. Multiple `@koi/middleware-audit`
  // entries pointing at the same `.audit.ndjson` would otherwise
  // create independent NDJSON writers and independent hash/signing
  // chains, interleaving their records into one file and making
  // any later verification meaningless. Runs BEFORE any factory
  // so no resources leak on the rejection path.
  //
  // Canonicalization is symlink-aware: we resolve the real parent
  // directory via `realpathSync` and join it with the basename.
  // Two in-tree aliases such as `logs/a.audit.ndjson` and
  // `real-logs/a.audit.ndjson` (where `logs` is a symlink to
  // `real-logs`) collapse to the same canonical key and are
  // correctly rejected as duplicates. Lexical resolvePath alone
  // would treat them as distinct.
  //
  // This check is limited to the one built-in that opens a file
  // (`@koi/middleware-audit`). Other built-ins that don't allocate
  // file resources don't need dedup.
  const claimedAuditPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.enabled === false || entry.name !== "@koi/middleware-audit") {
      continue;
    }
    const rawFilePath = entry.options?.filePath;
    if (typeof rawFilePath !== "string" || rawFilePath.length === 0) {
      // Let the per-entry factory surface the clearer validation
      // error; skip dedup so we don't mask it.
      continue;
    }
    const canonical = canonicalizeAuditSinkPath(rawFilePath, ctx.workingDirectory);
    if (canonical === undefined) {
      // Parent dir realpath failed (e.g. ENOENT on a subdirectory
      // that doesn't exist yet). Let the factory's own validation
      // surface the clearer error during resolution instead of
      // masking it here.
      continue;
    }
    if (claimedAuditPaths.has(canonical)) {
      throw new Error(
        `@koi/middleware-audit: filePath "${rawFilePath}" is already claimed by an earlier manifest entry in this session. ` +
          "Two audit entries cannot share the same canonical target — they would interleave records and corrupt any hash/signing chain. " +
          "Merge them into one entry, or target a different file.",
      );
    }
    claimedAuditPaths.add(canonical);
  }

  const resolved: KoiMiddleware[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) {
      continue;
    }
    // Re-apply the core blocklist at runtime. Embedders calling
    // createKoiRuntime programmatically do not go through
    // loadManifestConfig, so the YAML-level parser check is not
    // enough to stop a caller from naming a core layer via the
    // public manifestMiddleware API.
    if (CORE_MIDDLEWARE_BLOCKLIST.includes(entry.name)) {
      throw new CoreMiddlewareBlockedError(entry.name);
    }
    const factory = registry.get(entry.name);
    if (factory === undefined) {
      throw new UnknownManifestMiddlewareError(entry.name, registry.names());
    }
    const fromFactory = await factory(entry, ctx);
    if (registry.isTrusted(entry.name)) {
      // Trusted built-ins bypass the zone-B adapter entirely.
      // They retain their native `phase`/`priority` and may
      // expose the full middleware interface including
      // `wrapModelStream`, because we own and audit the source
      // code. The trust boundary this relaxes is "middleware
      // code might mutate" — the built-in factories are still
      // responsible for scrubbing their own records (e.g. audit
      // forces redactRequestBodies).
      resolved.push(fromFactory);
      continue;
    }
    // Untrusted registrations go through the delegating adapter:
    // phase/priority are forced to the zone-B slot, `concurrent`
    // is forced true, and `wrapModelStream` is rejected. The
    // adapter uses `.bind(fromFactory)` so method calls still
    // execute against the original instance with its private
    // fields (`#foo` / internal slots) intact — cloning
    // strategies (Object.create or object-spread) would lose
    // those.
    resolved.push(adaptToZoneBSlot(fromFactory));
  }
  return resolved;
}

/**
 * Wrap a middleware instance in a delegating adapter that forces
 * zone-B scheduling (phase + priority) without mutating or cloning
 * the inner object.
 *
 * Every optional hook on `KoiMiddleware` is forwarded with
 * `.bind(inner)` when present, which:
 *   1. Keeps the method's `this` pointing at the real instance so
 *      private fields (`#foo`), getters, and other non-serializable
 *      state continue to work.
 *   2. Preserves the hook's absence when the factory did not
 *      provide it (returning `undefined` means the engine skips
 *      that step, which matches the inner's intent).
 *
 * The required `describeCapabilities` hook is wrapped with a
 * non-optional forwarder; the engine asserts it exists on every
 * middleware, and binding preserves its `this` reference.
 *
 * `concurrent` is forwarded as a plain value — it's advisory for
 * the engine's observe-phase scheduler, not a function, so there
 * is no `this` to preserve.
 */
function adaptToZoneBSlot(inner: KoiMiddleware): KoiMiddleware {
  // Fail closed on manifest middleware that defines
  // `wrapModelStream`. Stream wrappers ignore the `concurrent`
  // flag (the engine compose docs are explicit: concurrent
  // observation is not supported for streaming because observers
  // cannot meaningfully inspect an independent copy of an async
  // iterable). That means a stream wrapper at zone B's slot still
  // runs in the normal onion and can rewrite the request or
  // yielded chunks, bypassing the trust-boundary guarantee this
  // adapter is supposed to enforce. No built-in manifest
  // middleware implements `wrapModelStream` today; future
  // mutating stream observers must register through a different
  // host-owned path, not through manifest content.
  if (typeof inner.wrapModelStream === "function") {
    throw new Error(
      `manifest middleware "${inner.name}" implements wrapModelStream, which is not allowed for zone-B entries. ` +
        "Stream wrappers always run sequentially in the onion and can mutate provider-bound requests or yielded chunks, " +
        "which breaks the observational-only guarantee that repo-authored manifest middleware runs under. " +
        "Register stream observers programmatically through a custom host wiring instead.",
    );
  }
  return {
    name: inner.name,
    phase: ZONE_B_PHASE,
    priority: ZONE_B_PRIORITY,
    // Force concurrent observer mode regardless of what the inner
    // declared. See the block comment on ZONE_B_CONCURRENT for the
    // full rationale: this is how we keep zone-B middleware purely
    // observational (`wrapModelCall`/`wrapToolCall` run in parallel
    // with the real next handler instead of wrapping it).
    concurrent: ZONE_B_CONCURRENT,
    ...(inner.onSessionStart !== undefined
      ? { onSessionStart: inner.onSessionStart.bind(inner) }
      : {}),
    ...(inner.onSessionEnd !== undefined ? { onSessionEnd: inner.onSessionEnd.bind(inner) } : {}),
    ...(inner.onBeforeTurn !== undefined ? { onBeforeTurn: inner.onBeforeTurn.bind(inner) } : {}),
    ...(inner.onAfterTurn !== undefined ? { onAfterTurn: inner.onAfterTurn.bind(inner) } : {}),
    ...(inner.onBeforeStop !== undefined ? { onBeforeStop: inner.onBeforeStop.bind(inner) } : {}),
    ...(inner.wrapModelCall !== undefined
      ? { wrapModelCall: inner.wrapModelCall.bind(inner) }
      : {}),
    // wrapModelStream is intentionally NOT forwarded — the
    // pre-check above rejects any inner that defines it, so this
    // branch is unreachable. Keeping the explicit omission
    // documents the contract.
    ...(inner.wrapToolCall !== undefined ? { wrapToolCall: inner.wrapToolCall.bind(inner) } : {}),
    ...(inner.onPermissionDecision !== undefined
      ? { onPermissionDecision: inner.onPermissionDecision.bind(inner) }
      : {}),
    ...(inner.onConfigChange !== undefined
      ? { onConfigChange: inner.onConfigChange.bind(inner) }
      : {}),
    // `describeCapabilities` is required by the KoiMiddleware
    // interface, but stub/test middleware often omit it. Bind
    // through when present; otherwise fall back to a no-op that
    // returns `undefined`, which the engine treats as "skip
    // injection." This mirrors the typical production pattern
    // (return undefined unless the middleware needs to advertise
    // a capability fragment).
    describeCapabilities:
      typeof inner.describeCapabilities === "function"
        ? inner.describeCapabilities.bind(inner)
        : (): undefined => undefined,
  };
}

/**
 * Create an empty registry. Plugins and tests use this when they
 * want full control over which middleware names are resolvable,
 * without inheriting any built-ins.
 */
export function createDefaultManifestRegistry(): MiddlewareRegistry {
  return new MiddlewareRegistry();
}

/**
 * Options for the built-in manifest registry.
 */
export interface BuiltinManifestRegistryOptions {
  /**
   * When `true`, register manifest middleware that opens writable
   * files at resolution time (currently `@koi/middleware-audit`,
   * which creates an NDJSON sink). Default: `false`.
   *
   * This is a host-controlled gate: repo-authored `koi.yaml` cannot
   * flip it. Hosts opt in via CLI flag / env / trust-host config
   * and accept that manifest entries they enable are allowed to
   * create files inside the workspace (subject to the audit path
   * validation: `.audit.ndjson` suffix, no symlink escape, no `..`
   * traversal, no absolute paths).
   *
   * When `false` (default), the audit built-in is NOT registered,
   * so `manifest.middleware` entries naming `@koi/middleware-audit`
   * throw `UnknownManifestMiddlewareError` at resolution time. This
   * keeps repo content from creating any filesystem side effects
   * via manifest alone, regardless of path.
   */
  readonly allowFileBackedSinks?: boolean | undefined;
}

/**
 * Create a registry pre-populated with the audited built-in manifest
 * middleware. Hosts pass this when constructing the runtime; the
 * default registry returned by `createDefaultManifestRegistry()` is
 * empty.
 *
 * The set is intentionally small and defense-in-depth. A built-in
 * candidate must meet every criterion in the stack-vs-manifest
 * decision rule (`docs/L2/manifest.md`):
 *   - pure interposition — no providers, no exports
 *   - no hookExtras that need early-phase merging
 *   - no session-reset or shutdown lifecycle
 *   - no late-phase dependency on inherited middleware
 *   - not already wired via a preset stack (avoids double-wire)
 *
 * Additionally, built-ins that perform filesystem I/O at resolution
 * time (`@koi/middleware-audit` creates an NDJSON file sink) are
 * ONLY registered when the host passes
 * `{ allowFileBackedSinks: true }`. This keeps repo-authored
 * manifests from triggering disk writes without an explicit host
 * trust decision.
 *
 * Audited packages:
 *   - ✅ `@koi/middleware-audit`          — file sink, host-gated
 *   - ❌ `@koi/middleware-extraction`     — wired in memory stack
 *   - ❌ `@koi/middleware-semantic-retry` — wired in observability stack
 *   - ❌ `@koi/context-manager`           — utility lib, no factory
 */
export function createBuiltinManifestRegistry(
  options: BuiltinManifestRegistryOptions = {},
): MiddlewareRegistry {
  const registry = new MiddlewareRegistry();
  if (options.allowFileBackedSinks === true) {
    // Built-in audit is registered as `trusted`, which makes the
    // resolver skip the zone-B adapter for this entry. The audit
    // middleware runs in its native `observe/300` slot with full
    // wrapModelCall + wrapModelStream coverage, so both streaming
    // and non-streaming model calls end up in the NDJSON trail.
    // We can trust the middleware code because the koi repo owns
    // and audits it — the zone-B adapter's concurrent-observer
    // protection exists to defend against third-party / untrusted
    // middleware code. Repo-authored manifest CONFIG is still
    // constrained by the factory itself (forced redactRequestBodies,
    // path validation, signing rejection, dedup).
    registry.register("@koi/middleware-audit", createAuditManifestEntry, {
      trusted: true,
    });
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Built-in factories
// ---------------------------------------------------------------------------

/**
 * Options accepted by the `@koi/middleware-audit` manifest entry.
 *
 * The underlying middleware takes an `AuditSink` object which cannot
 * be expressed directly in YAML, so this factory translates a small
 * user-friendly shape into a real sink. Today only the NDJSON file
 * sink is supported; additional sinks can be added behind a `sink`
 * discriminator later without breaking existing manifests.
 */
interface AuditManifestOptions {
  readonly filePath: string;
  readonly flushIntervalMs?: number;
  // `redactRequestBodies` is intentionally NOT part of the
  // resolved options — the factory forces it to `true`
  // unconditionally. Zone B runs AFTER system-prompt / goal /
  // hooks / model-router in the engine sort, so an un-redacted
  // request dump would contain host-injected trusted instructions
  // (system prompt content, goal reminders, hook transformations,
  // final routed model parameters). Letting a repo-authored
  // manifest persist those bodies to an in-workspace NDJSON file
  // would widen the repo->host trust boundary by making hidden
  // runtime material extractable through committed config.
  // Manifest audit captures request metadata only; full request
  // bodies are only available to hosts that register audit
  // programmatically via a custom MiddlewareRegistry.
  //
  // `signing` is also NOT part of the resolved options —
  // parseAuditOptions rejects `signing: true` from manifest content
  // because the ephemeral keypair's public key is never persisted.
}

/**
 * Resolve a manifest-supplied audit sink path against the workspace
 * root and reject anything that escapes it. This is the trust-boundary
 * fix for Codex round 2/3 findings: without validation, a repo-authored
 * `koi.yaml` with `filePath: /Users/victim/.ssh/authorized_keys` (or a
 * committed symlink pointing out of tree) would trigger arbitrary file
 * writes at runtime assembly time, before any permission middleware runs.
 *
 * Defense in depth:
 *   1. Reject absolute paths literally.
 *   2. Reject lexical `..` traversal out of the workspace.
 *   3. Resolve the target's PARENT directory via `realpathSync` and
 *      confirm that the real parent is still inside the real workspace
 *      root. This blocks the symlink-escape class where a repo commits
 *      `logs/audit.ndjson` as a symlink to a host path that passes the
 *      lexical check but the subsequent file open would follow. The
 *      file itself may not exist yet, so we resolve the parent dir
 *      (which does exist or was created by the caller) rather than the
 *      file path.
 *
 * Hosts that genuinely need an absolute or out-of-workspace sink path
 * thread it programmatically via a custom `MiddlewareRegistry` that
 * registers its own factory — not via manifest content.
 */
/**
 * Required filename suffix for manifest-configured audit sinks.
 * Combined with the lexical + realpath checks, this prevents a
 * repo-authored `koi.yaml` from pointing `filePath` at an existing
 * arbitrary workspace file (e.g. `package.json`, `src/index.ts`,
 * `bun.lock`) and silently corrupting it by appending audit NDJSON.
 *
 * Legitimate manifest audit entries name a dedicated file such as
 * `./audit.audit.ndjson` or `logs/session.audit.ndjson`. Hosts that
 * want a different filename scheme configure the sink
 * programmatically via a custom `MiddlewareRegistry`, bypassing
 * this lexical guard.
 */
const AUDIT_FILE_SUFFIX = ".audit.ndjson";

function resolveAuditFilePath(filePath: string, workspaceRoot: string): string {
  if (!filePath.endsWith(AUDIT_FILE_SUFFIX)) {
    throw new Error(
      `@koi/middleware-audit: filePath "${filePath}" must end in "${AUDIT_FILE_SUFFIX}" when configured from manifest. ` +
        "The extension requirement prevents repo-authored config from pointing at existing arbitrary " +
        "workspace files (package.json, source files, etc.) and silently corrupting them by appending audit JSON. " +
        "Hosts that need a different filename scheme must configure the sink programmatically.",
    );
  }
  if (isAbsolute(filePath)) {
    throw new Error(
      `@koi/middleware-audit: absolute filePath "${filePath}" is not allowed in manifest — ` +
        "the path must be relative to the workspace root. " +
        "Hosts that require an absolute path must thread it programmatically, not via koi.yaml.",
    );
  }
  const lexicalResolved = resolvePath(workspaceRoot, filePath);
  const lexicalRel = relative(workspaceRoot, lexicalResolved);
  if (lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    throw new Error(
      `@koi/middleware-audit: filePath "${filePath}" escapes the workspace root "${workspaceRoot}" — ` +
        "paths that leave the workspace are rejected. " +
        "Audit sinks must stay inside the workspace when configured from manifest content.",
    );
  }

  // Symlink-aware check: resolve the parent directory AND, if the
  // target exists, the target itself via the real filesystem, and
  // verify both are inside the real workspace root. Two separate
  // checks because the file may not exist yet (first write).
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = realpathSync(workspaceRoot);
  } catch (err: unknown) {
    throw new Error(
      `@koi/middleware-audit: workspace root "${workspaceRoot}" could not be resolved: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const parentDir = dirname(lexicalResolved);
  let realParentDir: string;
  try {
    realParentDir = realpathSync(parentDir);
  } catch (err: unknown) {
    throw new Error(
      `@koi/middleware-audit: parent directory "${parentDir}" does not exist or cannot be resolved: ${
        err instanceof Error ? err.message : String(err)
      }. Create the directory inside the workspace before enabling the manifest entry.`,
    );
  }
  const parentRel = relative(realWorkspaceRoot, realParentDir);
  if (parentRel.startsWith("..") || isAbsolute(parentRel)) {
    throw new Error(
      `@koi/middleware-audit: filePath "${filePath}" resolves through a symlinked parent directory that escapes the workspace root — ` +
        `real parent "${realParentDir}" is outside real workspace "${realWorkspaceRoot}". ` +
        "Audit sinks must stay inside the real workspace when configured from manifest content.",
    );
  }

  // The file itself may be a committed symlink inside an in-tree
  // directory, e.g. `logs/audit.ndjson → /etc/passwd`. `realParentDir`
  // would be in-tree, but the final file open would still follow the
  // symlink and write out of tree. Use `lstat` to detect a symlink
  // without following it; if one exists, reject unconditionally.
  try {
    const stat = lstatSync(lexicalResolved);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `@koi/middleware-audit: filePath "${filePath}" is itself a symlink — audit sinks cannot be written via symlinks ` +
          "when configured from manifest content. Replace the symlink with a regular file, or configure the sink programmatically.",
      );
    }
    // For an existing regular file, also verify its realpath is
    // inside the real workspace. lstat gave us "not a symlink," so
    // realpath on the file is safe and equivalent to lexicalResolved.
    const realFile = realpathSync(lexicalResolved);
    const realFileRel = relative(realWorkspaceRoot, realFile);
    if (realFileRel.startsWith("..") || isAbsolute(realFileRel)) {
      throw new Error(
        `@koi/middleware-audit: existing filePath "${filePath}" resolves outside the workspace real root — ` +
          `real path "${realFile}" is outside real workspace "${realWorkspaceRoot}".`,
      );
    }
  } catch (err: unknown) {
    // ENOENT (file does not exist yet) is the expected happy path —
    // the parent directory was already verified above, so the sink
    // will create a new file inside a real in-tree directory. Any
    // other error (EACCES, EIO, the two thrown errors above) bubbles
    // up — we fail closed rather than silently proceeding.
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
  }

  return lexicalResolved;
}

/**
 * Compute a symlink-aware canonical key for an audit sink path so
 * `resolveManifestMiddleware` can dedup multiple entries that name
 * the same real file through different in-tree aliases.
 *
 * Resolves the parent directory via `realpathSync`, then joins with
 * the basename (lstat on the file itself is deliberately skipped
 * because the file may not exist yet on first run). Returns
 * `undefined` if the parent cannot be resolved (ENOENT, EACCES,
 * etc.) so the caller can skip dedup and let the factory's own
 * validation surface the clearer error.
 *
 * Does not enforce policy (absolute/traversal/workspace escape/
 * symlinked file) — that is `resolveAuditFilePath`'s job. This
 * helper only produces a stable key for equality checks.
 */
function canonicalizeAuditSinkPath(filePath: string, workspaceRoot: string): string | undefined {
  const lexical = resolvePath(workspaceRoot, filePath);
  try {
    const realParent = realpathSync(dirname(lexical));
    return resolvePath(realParent, basename(lexical));
  } catch {
    return undefined;
  }
}

function parseAuditOptions(
  raw: Readonly<Record<string, unknown>> | undefined,
): AuditManifestOptions {
  if (raw === undefined) {
    throw new Error(
      '@koi/middleware-audit: options are required — manifest entry must include `filePath` (e.g. `"@koi/middleware-audit": { filePath: "./audit.log" }`)',
    );
  }
  const filePath = raw.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("@koi/middleware-audit: options.filePath must be a non-empty string");
  }
  const flushIntervalMs = raw.flushIntervalMs;
  if (
    flushIntervalMs !== undefined &&
    (typeof flushIntervalMs !== "number" || flushIntervalMs <= 0)
  ) {
    throw new Error("@koi/middleware-audit: options.flushIntervalMs must be a positive number");
  }
  // `redactRequestBodies` is not configurable from manifest: the
  // factory forces it to `true` below (see AuditManifestOptions
  // block comment). Accepting the user's value here even for
  // validation would mislead — drop it silently. If the user
  // actually sets it, we warn so they know their value is ignored.
  if (raw.redactRequestBodies !== undefined) {
    console.warn(
      "[koi/manifest-audit] options.redactRequestBodies is ignored — manifest-configured audit always redacts request bodies to prevent repo-authored config from extracting host-injected system prompt / goal / hook content from an in-workspace NDJSON file.",
    );
  }
  const signing = raw.signing;
  if (signing !== undefined && typeof signing !== "boolean") {
    throw new Error("@koi/middleware-audit: options.signing must be a boolean");
  }
  // Reject `signing: true` from manifest content. The underlying
  // createAuditMiddleware({signing: true}) generates an ephemeral
  // Ed25519 keypair and exposes the public key only on the returned
  // middleware instance — this registry path does not persist or
  // publish the key anywhere durable, so every entry the sink
  // writes is signed with a keypair that vanishes at process exit.
  // That turns tamper-evident mode into a false assurance during
  // incident response. Fail closed until there's a host-controlled
  // key-export path; hosts that need verifiable signing must wire
  // the audit middleware programmatically via a custom registry
  // factory where they own the key lifecycle.
  if (signing === true) {
    throw new Error(
      "@koi/middleware-audit: options.signing is not supported from manifest. " +
        "The underlying middleware generates an ephemeral keypair whose public key is not persisted, " +
        "so any signatures produced from manifest config cannot be verified after process exit. " +
        "Hosts that need tamper-evident audit must register the middleware programmatically via a custom MiddlewareRegistry so they own the key export path.",
    );
  }
  return {
    filePath,
    ...(typeof flushIntervalMs === "number" ? { flushIntervalMs } : {}),
  };
}

function createAuditManifestEntry(
  entry: ManifestMiddlewareEntry,
  ctx: ManifestMiddlewareContext,
): KoiMiddleware {
  const options = parseAuditOptions(entry.options);
  const safeFilePath = resolveAuditFilePath(options.filePath, ctx.workingDirectory);

  // Shared-sink cache: parent resolve + every spawned child's
  // re-resolve hits this path for the same canonical filePath.
  // The first resolver opens the sink and registers close() with
  // the runtime's shutdown chain. Subsequent resolvers (child
  // spawns) reuse the cached sink so there is exactly ONE writer
  // per file in the runtime — interleaved records from parent
  // and children are fine because each record carries its own
  // sessionId tag, but independent writers would duplicate the
  // file writer + flush timer + hash chain and corrupt output.
  // The cache key is the canonical absolute path; each child
  // still gets its own audit middleware instance (own queue,
  // own onSessionStart/End hooks) routed through the shared
  // sink.
  const cachedSink = ctx.sharedAuditSinks.get(safeFilePath);
  const sinkIsNew = cachedSink === undefined;
  const sink: ClosableAuditSink =
    cachedSink ??
    createNdjsonAuditSink({
      filePath: safeFilePath,
      ...(options.flushIntervalMs !== undefined
        ? { flushIntervalMs: options.flushIntervalMs }
        : {}),
    });
  if (sinkIsNew) {
    ctx.sharedAuditSinks.set(safeFilePath, sink);
  }

  // Poison-on-failure counters: audit writes that fail are a
  // material integrity gap. The audit queue invokes `onError`
  // whenever `sink.log()` rejects; we count the failures per
  // sink (shared across all middleware instances that use the
  // same cached sink) and raise them on the shutdown hook via
  // the dispose path. For a security/audit feature, silent
  // record loss is worse than a loud shutdown failure.
  //
  // The counters are attached to the cached sink via a weakly
  // held shared state so parent + children's `onError`
  // increment the same counter. `let` and the shared object are
  // justified for explicit mutable accounting.
  const sharedState = getOrInitAuditSinkState(sink);

  if (sinkIsNew) {
    // Only the first resolver that opens this sink registers
    // the close + failure-check hook. Subsequent resolvers
    // re-use the cached sink without re-registering close
    // (otherwise the dispose chain would try to close an
    // already-ended writer).
    ctx.registerShutdown(async () => {
      await sink.close();
      if (sharedState.writeFailures > 0) {
        throw new Error(
          `manifest @koi/middleware-audit: ${sharedState.writeFailures} audit write(s) failed during the session. ` +
            "The NDJSON trail for this run is incomplete and cannot be treated as authoritative. " +
            `First error: ${sharedState.firstError instanceof Error ? sharedState.firstError.message : String(sharedState.firstError)}`,
          { cause: sharedState.firstError },
        );
      }
    });
  }

  // Built-in audit is registered as `trusted` in the built-in
  // registry, which means the resolver skips the zone-B adapter
  // and returns this middleware verbatim. The audit middleware
  // runs in its native `observe/300` slot with both wrapModelCall
  // AND wrapModelStream covering streaming and non-streaming
  // model calls.
  //
  // `redactRequestBodies` is forced `true` regardless of caller
  // input (see AuditManifestOptions block comment). Zone B runs
  // after system-prompt / goal / hooks / model-router injection,
  // so an un-redacted dump would let a repo-authored manifest
  // extract host-injected trusted content from the NDJSON file.
  // Hosts that need un-redacted bodies register audit
  // programmatically via a custom MiddlewareRegistry.
  return createAuditMiddleware({
    sink,
    redactRequestBodies: true,
    onError: (err: unknown) => {
      sharedState.writeFailures += 1;
      if (sharedState.firstError === undefined) {
        sharedState.firstError = err;
      }
    },
    // signing deliberately omitted — see parseAuditOptions for why.
  });
}

/**
 * Per-sink shared state used by `createAuditManifestEntry` to
 * aggregate write-failure counts across parent and all child
 * audit middleware instances that target the same cached sink.
 * Stored in a `WeakMap<AuditSink, AuditSinkSharedState>` so the
 * state is released when the sink is garbage collected.
 */
interface AuditSinkSharedState {
  writeFailures: number;
  firstError: unknown;
}

const auditSinkSharedStates = new WeakMap<ClosableAuditSink, AuditSinkSharedState>();

function getOrInitAuditSinkState(sink: ClosableAuditSink): AuditSinkSharedState {
  let state = auditSinkSharedStates.get(sink);
  if (state === undefined) {
    state = { writeFailures: 0, firstError: undefined };
    auditSinkSharedStates.set(sink, state);
  }
  return state;
}
