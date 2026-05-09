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
 * Render mount identity with XML-attribute escaping only. Earlier
 * iterations attempted lossy `_` substitution and reversible percent-
 * encoding for "strict" mode, but both broke path round-tripping: the
 * model would see `/gmail/alice%40example.com` or `/gmail/alice_example.com`
 * and issue tool calls against those paths, while the live mount stayed
 * at `/gmail/alice@example.com`. Filesystem operations would then fail
 * or hit the wrong target.
 *
 * Defense at this layer:
 *   - escapeXmlAttr neutralizes `<`, `>`, `&`, `"` so identifiers cannot
 *     break the surrounding XML structure or open new tags.
 *   - The `strict` flag is retained on the API surface for backward
 *     compatibility but no longer alters rendering. Connector trust
 *     and the bridge's URI-scheme allowlist remain the boundary for
 *     mount-name *content*; this layer only renders.
 */
function renderBlock(
  tag: "mounted_connectors" | "runtime_mounted_connectors",
  entries: readonly MountDescription[],
  _strict: boolean,
): string | undefined {
  if (entries.length === 0) return undefined;
  const items = entries
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
