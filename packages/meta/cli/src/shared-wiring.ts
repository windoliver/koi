/**
 * Shared runtime-wiring helpers for `koi start` and `koi tui`.
 *
 * The two commands have independent runtime-assembly flows (different
 * tool stacks, different middleware ordering, different permission
 * defaults) but a handful of L2 subsystems are wired identically on
 * both sides. This module consolidates those pieces so neither command
 * drifts from the other and so the merging logic is tested in one place.
 *
 * Extracted here:
 *   - User MCP setup   (.mcp.json → resolver → provider [+ skills bridge])
 *   - Plugin MCP setup (activated plugins' mcpServers → resolver → provider)
 *   - User hook loading (~/.koi/hooks.json → tier-tagged RegisteredHook[])
 *   - User + plugin hook merging (tier-tagged, deterministic order)
 *   - Session resume (JSONL transcript → resumed messages + repair issues)
 *
 * Intentionally NOT extracted: bash tool wiring (TUI uses
 * createBashToolWithHooks + elicit + trackCwd; `koi start` uses the
 * simpler createBashTool), permission backend construction (auto-allow
 * vs tiered rules), filesystem tools, and middleware composition order
 * — those are load-bearing differences between the two commands and
 * belong in the command files themselves.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  ComponentProvider,
  HookConfig,
  InboundMessage,
  KoiMiddleware,
  SessionId,
  SessionTranscript,
  Tool,
} from "@koi/core";
import {
  createSingleToolProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  sessionId,
  toolToken,
} from "@koi/core";
import { createSystemPromptMiddleware } from "@koi/engine";
import { createLocalFileSystem } from "@koi/fs-local";
import type { CreateHookMiddlewareOptions, RegisteredHook } from "@koi/hooks";
import {
  createHookMiddleware,
  createRegisteredHooks,
  loadRegisteredHooksPerEntry,
} from "@koi/hooks";
import type { McpResolver, McpServerConfig } from "@koi/mcp";
import { createMcpComponentProvider, createMcpResolver, loadMcpJsonFile } from "@koi/mcp";
import type { SkillsMcpBridge } from "@koi/runtime";
import { createSkillsMcpBridge } from "@koi/runtime";
import { createSessionTranscriptMiddleware, resumeForSession } from "@koi/session";
import type { SkillsRuntime } from "@koi/skills-runtime";
import {
  createBuiltinSearchProvider,
  createFsEditTool,
  createFsReadTool,
  createFsWriteTool,
} from "@koi/tools-builtin";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";
import { createOAuthAwareMcpConnection } from "./mcp-connection-factory.js";

/** Common shape for an assembled MCP setup — user config or plugin-provided. */
export interface McpSetup {
  readonly resolver: McpResolver;
  readonly provider: ComponentProvider;
  /** Non-undefined only when a SkillsRuntime was supplied at construction. */
  readonly bridge: SkillsMcpBridge | undefined;
  /** Disposes the bridge (if any) and the underlying resolver. Idempotent. */
  readonly dispose: () => void;
}

/** Absolute path of `~/.koi/hooks.json` — the single user-tier hook source. */
export const USER_HOOKS_CONFIG_PATH: string = join(homedir(), ".koi", "hooks.json");

/**
 * Test-only override for the resolved user hooks config path. Tests call
 * `__setUserHooksConfigPathForTests(path)` in `beforeEach` to point the
 * loader at a sandbox directory and reset it in `afterEach`.
 */
let testHookPathOverride: string | undefined;

/** Test seam — never call in production code. */
export function __setUserHooksConfigPathForTests(path: string | undefined): void {
  testHookPathOverride = path;
}

/**
 * Resolve the user hooks config path lazily.
 *
 * Resolution order:
 * 1. Test override (`__setUserHooksConfigPathForTests`) — test-only.
 * 2. `KOI_HOOKS_CONFIG_PATH` env var — explicit deployment override. Security-
 *    sensitive environments (systemd units, launchd wrappers, `sudo -E`,
 *    or any other launcher that preserves an untrusted `$HOME`) should set
 *    this to a fixed absolute path so hook resolution bypasses home-directory
 *    ambiguity entirely. This closes a real trust-boundary issue: Bun's
 *    `os.homedir()` and `os.userInfo().homedir` BOTH honor `$HOME` at
 *    process launch (unlike Node's `userInfo().homedir`), so a
 *    launch-time HOME injection can otherwise redirect the loader to an
 *    attacker-controlled directory.
 * 3. `~/.koi/hooks.json` via `os.homedir()` — the default for interactive
 *    dev sessions where the operator controls their own environment.
 *
 * Documentation: deployments that treat hooks as policy-bearing should
 * either unset `$HOME` before launching koi or set `KOI_HOOKS_CONFIG_PATH`
 * explicitly — this is called out in `phase-2-bug-bash.md`.
 */
function resolveUserHooksConfigPath(): string {
  if (testHookPathOverride !== undefined) return testHookPathOverride;
  const explicitPath = process.env.KOI_HOOKS_CONFIG_PATH;
  if (explicitPath !== undefined && explicitPath.length > 0) {
    // Reject relative paths: a relative KOI_HOOKS_CONFIG_PATH defeats the
    // whole point of the trust-boundary fix by making resolution
    // cwd-dependent. An attacker who can influence the launcher's cwd
    // (service restart, wrapper script, etc.) could redirect the loader
    // to an alternate hooks file (third-loop round 2 finding).
    if (!isAbsolute(explicitPath)) {
      throw new Error(
        `Refusing to start: KOI_HOOKS_CONFIG_PATH="${explicitPath}" must be an absolute path. Relative paths are rejected because they depend on the launcher's working directory and defeat the purpose of pinning a hooks file.`,
      );
    }
    return explicitPath;
  }
  return join(homedir(), ".koi", "hooks.json");
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

/**
 * Load `.mcp.json` from the given cwd and assemble an McpSetup.
 *
 * Returns undefined when the file is absent, unreadable, or declares no
 * servers — matching the prior behavior of both call sites (silent skip).
 * When a SkillsRuntime is provided, also wires a best-effort SkillsMcpBridge
 * so MCP tools become discoverable as skills; a failing bridge.sync() is
 * demoted to "no bridge" rather than a fatal error, again matching the
 * prior TUI behavior.
 */
export async function loadUserMcpSetup(
  cwd: string,
  skillsRuntime: SkillsRuntime | undefined,
): Promise<McpSetup | undefined> {
  const mcpConfigPath = join(cwd, ".mcp.json");
  const result = await loadMcpJsonFile(mcpConfigPath);
  if (!result.ok) return undefined;
  if (result.value.servers.length === 0) return undefined;

  const connections = result.value.servers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });

  let bridge: SkillsMcpBridge | undefined;
  if (skillsRuntime !== undefined) {
    bridge = createSkillsMcpBridge({ resolver, runtime: skillsRuntime });
    try {
      await bridge.sync();
    } catch {
      // Non-fatal — MCP tools just won't appear as skills for this session.
      bridge = undefined;
    }
  }

  return {
    resolver,
    provider,
    bridge,
    dispose: () => {
      bridge?.dispose();
      resolver.dispose();
    },
  };
}

/**
 * Assemble an McpSetup from the McpServerConfig list provided by activated
 * plugins. Returns undefined when no plugin declared any MCP servers. Plugin
 * setups never carry a SkillsRuntime bridge because plugins register their
 * skills through the separate SkillsRuntime.registerExternal pipeline.
 */
export function buildPluginMcpSetup(
  pluginMcpServers: readonly McpServerConfig[],
): McpSetup | undefined {
  if (pluginMcpServers.length === 0) return undefined;
  const connections = pluginMcpServers.map((server) => createOAuthAwareMcpConnection(server));
  const resolver = createMcpResolver(connections);
  const provider = createMcpComponentProvider({ resolver });
  return {
    resolver,
    provider,
    bridge: undefined,
    dispose: () => {
      resolver.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Hook loading + merging
// ---------------------------------------------------------------------------

/**
 * Load user-tier hooks from `~/.koi/hooks.json` as tier-tagged
 * `RegisteredHook`s.
 *
 * Loader semantics (default):
 * - File absent → silent empty result (hooks.json is optional).
 * - File present but unreadable / not JSON → **fatal**. We cannot inspect
 *   the file for operator intent (a `failClosed: true` hook could be
 *   anywhere inside), so we cannot pretend nothing was configured. This
 *   matches the consistent reviewer recommendation across multiple
 *   rounds: file-level corruption is too dangerous to degrade to empty.
 * - File present, parseable, but structurally invalid (non-array root) →
 *   **fatal** for the same reason. We cannot enumerate entries to honor
 *   per-entry failClosed intent.
 * - File present and parseable as an array → each entry is validated
 *   independently via `loadRegisteredHooksPerEntry`. Invalid entries are
 *   reported through `onLoadError` and skipped; valid peers still load.
 *   This preserves issue #1781's intent (one bad hook doesn't nuke the
 *   whole file) for the common case of typos/env-specific failures.
 * - Any per-entry error (schema or duplicate) carrying `failClosed: true`
 *   → **fatal**. The per-hook opt-in is the finer-grained fail-closed
 *   contract for specific load-critical hooks.
 *
 * Strict mode (`KOI_HOOKS_STRICT=1`):
 * Turns every remaining non-fatal path into fatal: ordinary schema
 * errors and duplicate names abort startup even without `failClosed`.
 * Appropriate for deployments where any hook config error must refuse
 * to run rather than silently proceed with a reduced hook set.
 *
 * All diagnostics are reported through `onLoadError` BEFORE any fatal
 * throw so operators see every broken entry, not just the first fatal.
 * Callers that don't want startup to abort should wrap the call in try/catch.
 *
 * When `filterAgentHooks` is true, any `kind: "agent"` hooks are stripped
 * from the raw array **before** per-entry validation (and their names
 * reported via the optional callback). Pre-filtering matters: the TUI does
 * not support agent hooks at all, so a malformed or failClosed agent hook,
 * or a duplicate involving one, must not abort startup for a host that
 * would have ignored the entry anyway (review round 5 finding). Agent
 * hooks require a spawnFn that the TUI does not provide.
 */
export async function loadUserRegisteredHooks(options: {
  readonly filterAgentHooks: boolean;
  readonly onAgentHooksFiltered?: (hookNames: readonly string[]) => void;
  readonly onLoadError?: (message: string) => void;
}): Promise<readonly RegisteredHook[]> {
  const strictMode = process.env.KOI_HOOKS_STRICT === "1";
  const path = resolveUserHooksConfigPath();

  // Single-step read: attempting `file.exists()` then `file.json()` was a
  // TOCTOU race that treated any atomic replace/delete between the two
  // operations as fatal corruption, even on routine editor saves (review
  // third-loop r3 finding). We now try the read directly and treat
  // ENOENT as "file absent" (silent empty). Any other error — a real
  // parse failure, permission issue, or concurrent truncation — is still
  // fatal because the file existed but produced unknown content, which
  // could have hidden a failClosed hook.
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (e) {
    // Bun surfaces a missing file with an error whose `code` is "ENOENT".
    // Guard against both the Node-style code property and a message
    // fallback so the detection survives small runtime divergences.
    const errCode =
      typeof e === "object" && e !== null && "code" in e
        ? (e as { readonly code?: unknown }).code
        : undefined;
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errCode === "ENOENT" || /ENOENT|no such file/i.test(errMsg)) {
      return [];
    }
    const msg = `Could not read ${path}: ${errMsg}`;
    options.onLoadError?.(msg);
    throw new Error(`Refusing to start: ${msg}. Fix or remove the file before retrying.`);
  }

  // Agent-hook handling for hosts that cannot run agent hooks
  // (filterAgentHooks: true). Three cases in priority order:
  //
  // 1. Strict mode + any agent entry → fatal. The operator opted into
  //    "fail on anything the loader cannot honor," and silently dropping
  //    unsupported types under KOI_HOOKS_STRICT=1 is exactly the class of
  //    bypass strict mode exists to prevent (review round 7 new finding).
  //
  // 2. Lenient mode + agent entry marked `failClosed: true` → fatal. Even
  //    outside strict mode, the per-hook failClosed opt-in is the explicit
  //    contract: the operator declared this hook load-critical and the
  //    host cannot honor it, so refusing to start is the only truthful
  //    response. This preserves the failClosed guarantee for operators
  //    who share a hooks.json across TUI and agent-capable hosts.
  //
  // 3. Otherwise → silently strip the agent entries before validation and
  //    report the names via `onAgentHooksFiltered` (round 5 behaviour).
  //    Stripping before validation means malformed/duplicate agent entries
  //    cannot abort startup for a host that would have ignored them anyway.
  let effectiveRaw: unknown = raw;
  if (options.filterAgentHooks && Array.isArray(raw)) {
    const keptEntries: unknown[] = [];
    // Display labels cover EVERY filtered agent entry — named or not —
    // so the strict-mode gate cannot be silently bypassed by an unnamed
    // `{kind:"agent",...}` entry (review round 8 new finding). Unnamed
    // entries fall back to `entry <index>` labels.
    const agentLabels: string[] = [];
    // `agentNames` is a strict subset used for the `onAgentHooksFiltered`
    // callback, which historically receives only string names. Operators
    // see the full list (including unnamed entries) via the strict-mode
    // fatal message and via `onLoadError` when we surface a warning.
    const agentNames: string[] = [];
    const failClosedAgentLabels: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const entry: unknown = raw[i];
      if (
        typeof entry === "object" &&
        entry !== null &&
        (entry as { readonly kind?: unknown }).kind === "agent"
      ) {
        const sniffedName = (entry as { readonly name?: unknown }).name;
        const displayName =
          typeof sniffedName === "string" && sniffedName.length > 0 ? sniffedName : `entry ${i}`;
        agentLabels.push(displayName);
        if (typeof sniffedName === "string" && sniffedName.length > 0) {
          agentNames.push(sniffedName);
        }
        if ((entry as { readonly failClosed?: unknown }).failClosed === true) {
          failClosedAgentLabels.push(`"${displayName}"`);
        }
        continue;
      }
      keptEntries.push(entry);
    }

    // Surface named agent hooks via the legacy callback; surface unnamed
    // ones through onLoadError so operators can still identify them.
    if (agentNames.length > 0 && options.onAgentHooksFiltered !== undefined) {
      options.onAgentHooksFiltered(agentNames);
    }
    const unnamedAgents = agentLabels.length - agentNames.length;
    if (unnamedAgents > 0) {
      options.onLoadError?.(
        `${unnamedAgents} agent hook(s) without a parseable name were filtered from ${path}`,
      );
    }

    if (strictMode && agentLabels.length > 0) {
      throw new Error(
        `Refusing to start: ${agentLabels.length} agent hook(s) in ${path} (${agentLabels
          .map((l) => `"${l}"`)
          .join(
            ", ",
          )}) — this host does not support agent hooks and KOI_HOOKS_STRICT=1 does not permit silently dropping unsupported entries. Remove the agent entries or run via a host that supports them.`,
      );
    }
    if (failClosedAgentLabels.length > 0) {
      throw new Error(
        `Refusing to start: agent hook(s) marked failClosed:true cannot be loaded by this host (${failClosedAgentLabels.join(
          ", ",
        )}). Remove failClosed from the affected entries or run via a host that supports agent hooks.`,
      );
    }

    effectiveRaw = keptEntries;
  }

  const loaded = loadRegisteredHooksPerEntry(effectiveRaw, "user");
  if (options.onLoadError !== undefined) {
    for (const err of loaded.errors) {
      const where =
        err.index < 0
          ? "hooks.json"
          : err.name !== undefined
            ? `hooks.json entry ${err.index} ("${err.name}")`
            : `hooks.json entry ${err.index}`;
      options.onLoadError(`${where}: ${err.message}`);
    }
    for (const w of loaded.warnings) {
      options.onLoadError(`hooks.json: ${w}`);
    }
  }

  // Structural root errors (non-array, etc.) are always fatal — even
  // outside strict mode. We cannot enumerate entries to inspect
  // per-entry `failClosed: true` intent, so treating them as a
  // degraded-empty load would be a silent policy bypass.
  const structuralErrors = loaded.errors.filter((e) => e.kind === "structural");
  if (structuralErrors.length > 0) {
    throw new Error(
      `Refusing to start: ${path} is structurally invalid — ${structuralErrors
        .map((e) => e.message)
        .join("; ")}. Fix or remove the file before retrying.`,
    );
  }

  // Strict mode: any remaining per-entry error (schema, duplicate)
  // refuses startup, even without the per-hook failClosed opt-in.
  if (strictMode && loaded.errors.length > 0) {
    const summary = loaded.errors
      .map((e) => {
        const where =
          e.index < 0
            ? "root"
            : e.name !== undefined
              ? `entry ${e.index} ("${e.name}")`
              : `entry ${e.index}`;
        return `${where}: ${e.message}`;
      })
      .join("; ");
    throw new Error(
      `Refusing to start: ${path} has ${loaded.errors.length} hook load error(s) under KOI_HOOKS_STRICT=1 — ${summary}. Fix every entry before retrying.`,
    );
  }

  // Lenient mode fail-closed opt-in: any load error — schema or duplicate
  // — on an entry the operator explicitly marked `failClosed: true` aborts
  // startup even outside strict mode. The duplicate case matters: if an
  // operator edits a deny/audit hook in place but leaves the older copy
  // above it, the stricter replacement is declared load-critical and the
  // runtime must refuse to run the stale definition. Parse errors,
  // structural root errors, ordinary schema errors, and unmarked duplicates
  // still degrade to warnings + partial load in lenient mode so benign
  // config mistakes cannot deny service to the TUI / CLI.
  const failClosedErrors = loaded.errors.filter((e) => e.failClosed === true);
  if (failClosedErrors.length > 0) {
    const labels = failClosedErrors
      .map((e) => (e.name !== undefined ? `"${e.name}"` : `entry ${e.index}`))
      .join(", ");
    throw new Error(
      `Refusing to start: ${failClosedErrors.length} hook(s) marked failClosed:true failed to load (${labels}). Fix ${path} or remove failClosed from the affected entries.`,
    );
  }

  // When filterAgentHooks is true, agent entries were already stripped
  // from the raw array above; loaded.hooks never contains any. The post-
  // filter that used to live here is redundant.
  return loaded.hooks;
}

/**
 * Merge already-loaded user-tier hooks with plugin-provided `HookConfig`s
 * (tier-tagged as "session"), returning a single deterministic list in
 * user-then-plugin order.
 *
 * When `filterAgentHooks` is true, `kind: "agent"` plugin hooks are
 * silently dropped (with the names reported via `onFilteredAgentHooks`
 * so operators know what was skipped). Unlike USER hooks, plugin hooks
 * are auto-discovered from third-party packages the operator installed
 * but does not directly author — letting a plugin's `failClosed: true`
 * agent hook abort startup would mean any plugin update could brick
 * every TUI session on hosts that cannot run agent hooks, which is a
 * worse failure mode than the silent bypass it would prevent (review
 * third-loop r3 finding). Operators who need strict plugin enforcement
 * should audit their plugin set and remove unsupported plugins rather
 * than rely on startup-fatal load behaviour here.
 */
export function mergeUserAndPluginHooks(
  userHooks: readonly RegisteredHook[],
  pluginHookConfigs: readonly HookConfig[],
  options: {
    readonly filterAgentHooks: boolean;
    readonly onFilteredAgentHooks?: (hookNames: readonly string[]) => void;
  },
): readonly RegisteredHook[] {
  let effectivePluginConfigs = pluginHookConfigs;
  if (options.filterAgentHooks) {
    const agentHooks = pluginHookConfigs.filter((h) => h.kind === "agent");
    if (agentHooks.length > 0 && options.onFilteredAgentHooks !== undefined) {
      options.onFilteredAgentHooks(agentHooks.map((h) => h.name));
    }
    effectivePluginConfigs = pluginHookConfigs.filter((h) => h.kind !== "agent");
  }
  const pluginRegistered = createRegisteredHooks(effectivePluginConfigs, "session");
  return [...userHooks, ...pluginRegistered];
}

// ---------------------------------------------------------------------------
// Session resume
// ---------------------------------------------------------------------------

/** Successful resume payload — messages to rehydrate + repair-issue count. */
export interface ResumedSession {
  /** Branded id of the resumed session (same as the rawId argument, branded). */
  readonly sid: SessionId;
  /** Conversation history as it was when the session was last persisted. */
  readonly messages: readonly InboundMessage[];
  /**
   * Number of repair issues found while replaying the JSONL. Non-zero
   * means the transcript had corrupt or partial entries that the resume
   * pipeline recovered from; callers may want to surface this to the
   * operator (stderr for CLI, a system message for TUI).
   */
  readonly issueCount: number;
}

/**
 * Load a JSONL session transcript and return the rehydrated messages.
 *
 * This is the shared resume entrypoint for `koi start --resume` and
 * `koi tui --resume`. The helper branded-wraps the raw session id,
 * calls `@koi/session/resumeForSession`, and normalizes the result
 * into a plain `Result<ResumedSession, string>` so each command can
 * present the failure in its own UI idiom (stderr for start, a
 * rendered error banner for tui). The helper intentionally performs
 * no I/O-side logging — callers own the user-facing output.
 */
export async function resumeSessionFromJsonl(
  rawId: string,
  jsonlTranscript: SessionTranscript,
  sessionsDir: string,
): Promise<
  | { readonly ok: true; readonly value: ResumedSession }
  | { readonly ok: false; readonly error: string }
> {
  // Resume ids can arrive in two shapes:
  //   1. A plain branded id minted by this branch (e.g.
  //      `86cfcc00-...`). The file lives at
  //      `<sessionsDir>/86cfcc00-....jsonl` and the encoding is
  //      a no-op.
  //   2. A legacy composite id from an older engine or from
  //      `koi sessions list`, which exposes the raw basename
  //      without decoding (`agent%3A<pid>%3A<uuid>`). The file
  //      lives at `<sessionsDir>/agent%3A...%3A....jsonl`, but
  //      blindly passing that basename through
  //      `encodeURIComponent` produces `agent%253A...` and
  //      misses the file. Try raw first, then fall back to the
  //      decoded form so users can copy-paste either what
  //      `koi sessions list` prints OR what the new post-quit
  //      hint prints.
  const candidates: string[] = [rawId];
  try {
    const decoded = decodeURIComponent(rawId);
    if (decoded !== rawId) candidates.push(decoded);
  } catch {
    // Malformed percent-encoding — fall through with just the raw id.
  }

  // Fail closed for nonexistent session files. The JSONL store
  // returns `{ ok: true, entries: [] }` for a missing file so
  // that appends-to-new-sessions can work, which means a typoed
  // or stale `--resume <id>` would otherwise succeed silently
  // and fork into a new blank transcript under the mistyped id.
  // Valid-but-empty sessions (a file that exists but contains
  // zero turns because of a prior `/clear` truncate) must still
  // resume successfully, so we distinguish the two states by
  // probing filesystem existence directly — Bun.file exposes
  // an explicit `exists()` that the SessionTranscript interface
  // does not.
  // let: justified — assigned once a candidate's file is found
  let foundCanonical: string | null = null;
  // let: justified — captured for the error path below
  let lastProbedPath = "";
  for (const candidate of candidates) {
    const candidatePath = `${sessionsDir}/${encodeURIComponent(candidate)}.jsonl`;
    lastProbedPath = candidatePath;
    if (await Bun.file(candidatePath).exists()) {
      foundCanonical = candidate;
      break;
    }
  }
  if (foundCanonical === null) {
    return {
      ok: false,
      error:
        `no transcript found for session id "${rawId}" at ${lastProbedPath}. ` +
        "Check the id (the post-quit hint prints the exact command) or " +
        "use `koi sessions list` to see saved sessions.",
    };
  }

  const sid = sessionId(foundCanonical);
  const result = await resumeForSession(sid, jsonlTranscript);
  if (!result.ok) {
    return { ok: false, error: result.error.message };
  }
  return {
    ok: true,
    value: {
      sid,
      messages: result.value.messages,
      issueCount: result.value.issues.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared middleware factory wrappers
//
// These are the middleware types that both `koi start` and `koi tui` wire
// with IDENTICAL factory calls — only the position in the per-host stack
// differs. Each wrapper returns `undefined` when the input opts out so
// call sites can conditionally splice the result into their middleware
// array with a single `...(x !== undefined ? [x] : [])` spread.
//
// Rule: any middleware added here should be opt-in via a config field so
// a new host (CI runner, daemon, etc.) can wire only the pieces it wants.
// Host-specific middleware (event-trace, exfiltration-guard, etc.) stays
// in the host file — these wrappers are only for the overlap.
// ---------------------------------------------------------------------------

/**
 * Build the optional session-transcript middleware. Returns `undefined`
 * when no session is configured (e.g. `koi start --until-pass` loop mode
 * disables persistence because intermediate iterations are not resumable).
 */
export function buildSessionTranscriptMw(
  session: { readonly transcript: SessionTranscript; readonly sessionId: SessionId } | undefined,
): KoiMiddleware | undefined {
  if (session === undefined) return undefined;
  return createSessionTranscriptMiddleware({
    transcript: session.transcript,
    sessionId: session.sessionId,
  });
}

/**
 * Build the optional system-prompt middleware. Returns `undefined` when
 * the caller has no system prompt to inject (rare — both hosts currently
 * always supply one, but the config field is optional and this preserves
 * that shape).
 */
export function buildSystemPromptMw(prompt: string | undefined): KoiMiddleware | undefined {
  if (prompt === undefined || prompt.length === 0) return undefined;
  return createSystemPromptMiddleware(prompt);
}

/**
 * Build a hook middleware unconditionally from an already-merged
 * `RegisteredHook[]` plus host-specific extras. Used by hosts that need
 * the middleware slot populated even when no user hooks are registered
 * (e.g. the TUI's hook-observer tap, which still records trace spans).
 *
 * `extras` forwards host-specific options: the TUI passes `promptCallFn`
 * (for prompt-hook verification against its model adapter) and
 * `onExecuted` (for the hook-observer ATIF tap); `koi start` passes
 * neither. Any new option added to `CreateHookMiddlewareOptions` lands
 * here automatically.
 */
export function buildHookMw(
  hooks: readonly RegisteredHook[],
  extras?: Omit<CreateHookMiddlewareOptions, "hooks"> | undefined,
): KoiMiddleware {
  return createHookMiddleware({ hooks, ...(extras ?? {}) });
}

/**
 * Like `buildHookMw` but returns `undefined` when there are no hooks and
 * no `onExecuted` tap to record, so the caller can skip the middleware
 * slot entirely for a cleaner trace stack. `koi start` uses this variant
 * because it has no hook-observer tap to preserve.
 */
export function buildHookMwOrUndefined(
  hooks: readonly RegisteredHook[],
  extras?: Omit<CreateHookMiddlewareOptions, "hooks"> | undefined,
): KoiMiddleware | undefined {
  if (hooks.length === 0 && extras?.onExecuted === undefined) return undefined;
  return buildHookMw(hooks, extras);
}

// ---------------------------------------------------------------------------
// Shared core KoiMiddleware slots
//
// Both hosts need permissions + hook + system-prompt + session-transcript
// middleware, but they splice them into different positions in their
// full middleware array:
//   CLI:  [sessionTranscript, perm, hook, systemPrompt]         (perm → hook)
//   TUI:  [eventTrace, hook, hookObserver, rules, perm, exfil,  (hook → perm)
//          extract, semanticRetry, ..., systemPrompt, sessionTranscript]
//
// Rather than emit one ordered array that fits neither, this helper
// returns a tagged record of the slots. Each host composes the slots
// into its own middleware order. Adding a new core middleware type =
// one new slot on this record + one splice point in each host (still
// two edits, but the factory construction lives in one file).
// ---------------------------------------------------------------------------

export interface CoreMiddlewareConfig {
  /**
   * Permissions middleware — callers construct it with their own
   * PermissionBackend (CLI: auto-allow pattern backend; TUI: default
   * mode with tiered allow rules) because the backend shape drifts
   * too far to share.
   */
  readonly permissionsMiddleware: KoiMiddleware;
  /** Already-merged hook list (user + plugin, tier-tagged). */
  readonly hooks: readonly RegisteredHook[];
  /** Host-specific extras for `createHookMiddleware` (promptCallFn, onExecuted). */
  readonly hookExtras?: Omit<CreateHookMiddlewareOptions, "hooks"> | undefined;
  /**
   * When true, always install a hook-middleware slot even for empty
   * hook sets. Hosts with an observer tap (TUI records trace spans
   * through `onExecuted`) need the slot to stay; plain CLI omits it.
   */
  readonly forceHookSlot?: boolean;
  /** Optional system prompt; omitted → no system-prompt middleware. */
  readonly systemPrompt?: string | undefined;
  /** Optional session transcript; omitted → no session-transcript middleware. */
  readonly session?:
    | { readonly transcript: SessionTranscript; readonly sessionId: SessionId }
    | undefined;
}

/** Tagged slot record — each slot is `undefined` when its config opts out. */
export interface CoreMiddlewareSlots {
  readonly permissions: KoiMiddleware;
  readonly hook: KoiMiddleware | undefined;
  readonly systemPrompt: KoiMiddleware | undefined;
  readonly sessionTranscript: KoiMiddleware | undefined;
}

/**
 * Build the core middleware slots both hosts consume. The caller
 * composes these into its own middleware array in whatever order it
 * needs (CLI: outermost → innermost; TUI: wrapped in event-trace /
 * checkpoint / etc). A new core middleware type lands here as a new
 * slot and gains one-place maintenance.
 */
export function buildCoreMiddleware(config: CoreMiddlewareConfig): CoreMiddlewareSlots {
  const hookMw =
    config.forceHookSlot === true
      ? buildHookMw(config.hooks, config.hookExtras)
      : buildHookMwOrUndefined(config.hooks, config.hookExtras);
  return {
    permissions: config.permissionsMiddleware,
    hook: hookMw,
    systemPrompt: buildSystemPromptMw(config.systemPrompt),
    sessionTranscript: buildSessionTranscriptMw(config.session),
  };
}

// ---------------------------------------------------------------------------
// Shared core ComponentProviders
//
// The "core" set is the provider stack both `koi start` and `koi tui` should
// wire out of the box: filesystem read/write/edit, workspace search
// (Glob/Grep/ToolSearch), web_fetch, and shell. Adding a new tool to this
// builder lands in both hosts with one edit — the exact property the user
// asked for ("add a feature in one place, works for both").
//
// The bash tool is passed in as an opaque `Tool` rather than built here so
// the TUI can supply its fancier `createBashToolWithHooks` variant (CWD
// tracking, bash-AST elicit, hook integration) while `koi start` passes a
// plain `createBashTool`. Any other surface differences (Plan Mode,
// `AskUserQuestion`) are handled via the `additional` config field.
// ---------------------------------------------------------------------------

/** Wraps a single `Tool` as a named `ComponentProvider` for createKoi. */
export function wrapToolAsProvider(tool: Tool): ComponentProvider {
  const name = tool.descriptor.name;
  return {
    name,
    attach: async (): Promise<ReadonlyMap<string, unknown>> =>
      new Map([[toolToken(name) as unknown as string, tool]]),
  };
}

export interface CoreProvidersConfig {
  /** Workspace root — threaded into filesystem-scoped builders (Glob, fs tools). */
  readonly cwd: string;
  /**
   * Host-provided bash tool. Normally supplied by the execution preset
   * stack's `bashHandle.tool`. When `undefined` (execution stack
   * disabled via `manifest.stacks`), the core set omits the `Bash`
   * provider — the host runs without shell access.
   */
  readonly bashTool?: Tool | undefined;
  /**
   * When true, wire fs_read / fs_write / fs_edit via the local filesystem
   * backend with the unsandboxed policy. Defaults to `true` — a new host
   * opts out only when it runs against a remote/virtual filesystem and
   * wants its own backend bound here.
   */
  readonly includeFilesystemTools?: boolean;
  /**
   * When true, wire the web_fetch tool. Defaults to `true` — hosts that
   * run in airgapped environments can pass `false` to strip network access.
   */
  readonly includeWebFetch?: boolean;
  /**
   * Host-specific extra providers appended after the core set (e.g. TUI's
   * bash_background, task tools, memory, notebook, spawn). Added here
   * rather than by the caller splicing arrays so the assembly order is
   * always `[core..., extras...]` and reviewers can spot-check the spread.
   */
  readonly additional?: readonly ComponentProvider[];
}

/**
 * Build the core `ComponentProvider[]` both hosts consume.
 *
 * Order matters for debug/telemetry grouping, not for runtime semantics —
 * createKoi treats providers as an unordered set. The order here is
 * search → filesystem → web → shell so a human reading a trace spots
 * read-before-mutate tools first.
 */
export function buildCoreProviders(config: CoreProvidersConfig): ComponentProvider[] {
  const { cwd, bashTool } = config;
  const includeFs = config.includeFilesystemTools ?? true;
  const includeWeb = config.includeWebFetch ?? true;

  const providers: ComponentProvider[] = [createBuiltinSearchProvider({ cwd })];

  if (includeFs) {
    // allowExternalPaths: the runtime has a real permission middleware
    // (path-aware rules + approval handler) that gates out-of-workspace access.
    const localFs = createLocalFileSystem(cwd, { allowExternalPaths: true });
    providers.push(
      createSingleToolProvider({
        name: "fs-read",
        toolName: "fs_read",
        createTool: () => createFsReadTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
      }),
      createSingleToolProvider({
        name: "fs-write",
        toolName: "fs_write",
        createTool: () => createFsWriteTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
      }),
      createSingleToolProvider({
        name: "fs-edit",
        toolName: "fs_edit",
        createTool: () => createFsEditTool(localFs, "fs", DEFAULT_UNSANDBOXED_POLICY),
      }),
    );
  }

  if (includeWeb) {
    const webExecutor = createWebExecutor({ allowHttps: true });
    providers.push(
      createWebProvider({
        executor: webExecutor,
        policy: DEFAULT_UNSANDBOXED_POLICY,
        operations: ["fetch"],
      }),
    );
  }

  if (bashTool !== undefined) {
    providers.push(wrapToolAsProvider(bashTool));
  }

  if (config.additional !== undefined) {
    providers.push(...config.additional);
  }

  return providers;
}
