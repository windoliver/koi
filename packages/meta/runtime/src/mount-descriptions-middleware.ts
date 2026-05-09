import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import type { MountDescription } from "@koi/fs-nexus";

export interface MountDescriptionsSnapshot {
  readonly manifest: readonly MountDescription[];
  readonly runtime: readonly MountDescription[];
}

export interface MountDescriptionsState {
  readonly getSnapshot: () => MountDescriptionsSnapshot;
  /**
   * Returns true when the state is configured with prompt-safety strict
   * mode. Strict mode is applied at PROMPT RENDER time only — the canonical
   * snapshot retains every in-scope mount so /mounts and runtime
   * bookkeeping never lose live mounts whose identifiers happen to use
   * characters outside the allowlist (e.g. `@`, spaces).
   */
  readonly isStrictPromptMode: () => boolean;
  readonly setManifest: (entries: readonly MountDescription[]) => void;
  readonly addRuntime: (entry: MountDescription) => void;
  readonly remove: (path: string) => void;
  /**
   * Reconcile in-memory state against an authoritative list of mount paths
   * (typically the result of a fresh `transport.listMounts()`). Drops any
   * manifest or runtime entry whose path is not in `authoritative` so stale
   * state — mounts removed out of band, or `pathUnknown` placeholders that
   * never resolved — cannot keep being surfaced to the model or operator.
   */
  readonly reconcile: (authoritative: readonly string[]) => void;
  /**
   * Update the disclosure scope after construction. Filters all currently-
   * stored entries against the new scope so a state that was populated
   * before scope information was available (e.g. seed before
   * resolveFileSystemAsync returns) can still be tightened retroactively.
   */
  readonly setScope: (scopePaths: readonly string[] | undefined) => void;
}

/**
 * Filter mount entries against a session-disclosure scope (canonicalized
 * `/path` strings). When `scopePaths` is undefined or empty, no filtering is
 * applied. When set, only entries whose `path` falls within one of the
 * scopes (or whose scope falls within them) are retained. This mirrors the
 * filter applied at startup-seed time so runtime updates from `/mount` and
 * `/mounts` cannot disclose sibling mounts a scoped session was meant to
 * hide.
 */
function filterEntriesByScope(
  entries: readonly MountDescription[],
  scopePaths: readonly string[] | undefined,
): readonly MountDescription[] {
  if (scopePaths === undefined || scopePaths.length === 0) return entries;
  return entries.filter((entry) =>
    scopePaths.some(
      (scopePath) =>
        entry.path === scopePath ||
        entry.path.startsWith(`${scopePath}/`) ||
        scopePath.startsWith(`${entry.path}/`),
    ),
  );
}

/**
 * Optional config for the mount-descriptions state.
 *
 * `scopePaths` — when set, every mount entry written to the state (manifest
 * or runtime) is filtered against these canonicalized `/path` scopes before
 * being stored, so /mount and /mounts updates obey the same disclosure
 * boundary that startup-seed applies.
 *
 * `strictPromptIdentifiers` — when true, entries whose `path` or `connector`
 * fail the prompt-safe character allowlist are rejected at write time. Use
 * for sessions where mount names flow through to the system prompt.
 */
export interface MountDescriptionsStateConfig {
  readonly initial?: Partial<MountDescriptionsSnapshot> | undefined;
  readonly scopePaths?: readonly string[] | undefined;
  readonly strictPromptIdentifiers?: boolean | undefined;
}

export function createMountDescriptionsState(
  configOrInitial?: MountDescriptionsStateConfig | Partial<MountDescriptionsSnapshot> | undefined,
): MountDescriptionsState {
  // Backward-compat: accept the original `Partial<MountDescriptionsSnapshot>`
  // shape OR the new full config object. Disambiguate by checking for
  // config-only fields.
  const config: MountDescriptionsStateConfig =
    configOrInitial !== undefined &&
    ("scopePaths" in configOrInitial ||
      "strictPromptIdentifiers" in configOrInitial ||
      "initial" in configOrInitial)
      ? (configOrInitial as MountDescriptionsStateConfig)
      : { initial: configOrInitial as Partial<MountDescriptionsSnapshot> | undefined };
  let scopePaths = config.scopePaths;
  const strict = config.strictPromptIdentifiers === true;

  // Scope filter only — prompt-safety filtering is applied at render time
  // (renderBlock + middleware), not here. Filtering by identifier
  // characters at write time would silently drop legitimate live mounts
  // (e.g. emails containing '@', display names with spaces) from the
  // canonical snapshot, breaking /mounts visibility and runtime
  // bookkeeping. The state is the source of truth for "what is mounted";
  // the prompt is just one consumer.
  const allow = (entries: readonly MountDescription[]): readonly MountDescription[] =>
    filterEntriesByScope(entries, scopePaths);

  let manifest = sortManifest(allow(config.initial?.manifest ?? []));
  let runtime = [...allow(config.initial?.runtime ?? [])];

  return {
    getSnapshot: (): MountDescriptionsSnapshot => ({
      manifest,
      runtime,
    }),
    isStrictPromptMode: (): boolean => strict,
    setManifest: (entries): void => {
      manifest = sortManifest(allow(entries));
    },
    addRuntime: (entry): void => {
      const accepted = allow([entry]);
      if (accepted.length === 0) return;
      runtime = [...runtime.filter((candidate) => candidate.path !== entry.path), ...accepted];
    },
    remove: (path): void => {
      manifest = manifest.filter((entry) => entry.path !== path);
      runtime = runtime.filter((entry) => entry.path !== path);
    },
    reconcile: (authoritative): void => {
      const live = new Set(authoritative);
      manifest = manifest.filter((entry) => live.has(entry.path));
      runtime = runtime.filter((entry) => live.has(entry.path));
    },
    setScope: (paths): void => {
      scopePaths = paths;
      // Re-apply the new scope to currently-held entries so anything that
      // slipped in before the scope was known is removed retroactively.
      manifest = sortManifest(allow(manifest));
      runtime = [...allow(runtime)];
    },
  };
}

function sortManifest(entries: readonly MountDescription[]): readonly MountDescription[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Prompt-safe identifier allowlist. Identifiers that flow into the
 * `<connector path="..." name="..." />` block of the system prompt must be
 * drawn from a conservative character set — anything else is omitted from
 * the rendered block (but retained in the operator-facing
 * `MountDescriptionsState` snapshot, so /mounts and runtime bookkeeping
 * still see live mounts whose names contain `@`, spaces, etc.).
 *
 * Path: one or more `/segment` runs, each segment using `[A-Za-z0-9._-]`.
 * Connector: a single `[A-Za-z0-9._-]` token.
 *
 * XML escaping (escapeXmlAttr) remains a defense-in-depth layer for the
 * permitted characters; this allowlist is the primary filter.
 */
const PROMPT_SAFE_PATH = /^(?:\/[A-Za-z0-9._-]+)+$/;
const PROMPT_SAFE_CONNECTOR = /^[A-Za-z0-9._-]+$/;

function isPromptSafeEntry(entry: MountDescription): boolean {
  if (!PROMPT_SAFE_PATH.test(entry.path)) return false;
  // The character class above admits `.`, so `/foo/..` and `/foo/.` both
  // pass the structural test. Reject any segment that is exactly `.` or
  // `..` so traversal-like identifiers cannot reach the system prompt.
  for (const segment of entry.path.split("/")) {
    if (segment === "." || segment === "..") return false;
  }
  if (!PROMPT_SAFE_CONNECTOR.test(entry.connector)) return false;
  if (entry.connector === "." || entry.connector === "..") return false;
  return true;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the trusted identity block (path + connector name only).
 *
 * `path` and `connector` come from the operator-controlled mount URI / Nexus
 * routing layer, so they are safe to surface as system-prompt instructions.
 *
 * Connector-supplied free-text (e.g. README content carried in
 * `MountDescription.description`) is intentionally NOT injected into the
 * system prompt: that channel is the highest-trust prompt layer, and
 * connector-controlled text would compete with trusted runtime instructions.
 * Operators that want to surface README content to the model should expose it
 * via tool output or a dedicated lower-trust context channel instead.
 */
/**
 * Render the mount identity block.
 *
 * When `strict` is true, entries failing the prompt-safe identifier
 * allowlist (PROMPT_SAFE_PATH / PROMPT_SAFE_CONNECTOR) are OMITTED from the
 * rendered block — they are never injected into the system prompt — while
 * remaining in the operator-facing `MountDescriptionsState` snapshot so
 * /mounts continues to surface them to the user. Earlier iterations tried
 * lossy `_` substitution and reversible percent-encoding so that the model
 * could still see *something* for unsafe paths, but both broke round-trip:
 * the model would issue tool calls against the rewritten string while the
 * live mount stayed at its real path, so filesystem operations failed or
 * hit the wrong target. Omission is the only correct option — the model
 * simply does not see backend-controlled identifiers that fall outside the
 * allowlist.
 *
 * When `strict` is false, every entry is rendered with XML-attribute
 * escaping only. escapeXmlAttr remains a defense-in-depth layer in both
 * modes so that even allowlisted identifiers cannot break the surrounding
 * XML structure or open new tags.
 *
 * If filtering empties the block, the block is suppressed entirely (return
 * undefined) so the prompt never contains an empty `<mounted_connectors />`.
 */
function renderBlock(
  tag: "mounted_connectors" | "runtime_mounted_connectors",
  entries: readonly MountDescription[],
  strict: boolean,
): string | undefined {
  const visible = strict ? entries.filter(isPromptSafeEntry) : entries;
  if (visible.length === 0) return undefined;
  const items = visible
    .map((entry) => {
      const attrs = [
        `path="${escapeXmlAttr(entry.path)}"`,
        `name="${escapeXmlAttr(entry.connector)}"`,
      ];
      return `  <connector ${attrs.join(" ")} />`;
    })
    .join("\n");
  return `<${tag}>\n${items}\n</${tag}>`;
}

const AVAILABLE_SKILLS_BLOCK_PATTERN =
  /^(<available_skills>\n[\s\S]*?\n<\/available_skills>)(?:\n\n)?/;

function joinPromptSections(sections: readonly (string | undefined)[]): string | undefined {
  const filtered = sections.filter(
    (section): section is string => section !== undefined && section.length > 0,
  );
  if (filtered.length === 0) return undefined;
  return filtered.join("\n\n");
}

function injectMountDescriptions(
  snapshot: MountDescriptionsSnapshot,
  request: ModelRequest,
  strict: boolean,
): ModelRequest {
  const sections = [
    renderBlock("mounted_connectors", snapshot.manifest, strict),
    renderBlock("runtime_mounted_connectors", snapshot.runtime, strict),
  ].filter((value): value is string => value !== undefined);
  if (sections.length === 0) return request;
  const content = sections.join("\n\n");
  const existing = request.systemPrompt;
  if (existing === undefined || existing.length === 0) {
    return {
      ...request,
      systemPrompt: content,
    };
  }

  const skillsMatch = existing.match(AVAILABLE_SKILLS_BLOCK_PATTERN);
  if (skillsMatch === null) {
    return {
      ...request,
      systemPrompt: joinPromptSections([existing, content]),
    };
  }

  const skillsBlock = skillsMatch[1];
  const remainder = existing.slice(skillsMatch[0].length);
  return {
    ...request,
    systemPrompt: joinPromptSections([remainder, skillsBlock, content]),
  };
}

export function createMountDescriptionsMiddleware(config: {
  readonly state: MountDescriptionsState;
}): KoiMiddleware {
  return {
    name: "mount-descriptions",
    phase: "resolve" as const,
    priority: 350,
    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      return next(
        injectMountDescriptions(
          config.state.getSnapshot(),
          request,
          config.state.isStrictPromptMode(),
        ),
      );
    },
    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      yield* next(
        injectMountDescriptions(
          config.state.getSnapshot(),
          request,
          config.state.isStrictPromptMode(),
        ),
      );
    },
    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },
  };
}
