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
}

export function createMountDescriptionsState(
  initial?: Partial<MountDescriptionsSnapshot> | undefined,
): MountDescriptionsState {
  let manifest = sortManifest(initial?.manifest ?? []);
  let runtime = [...(initial?.runtime ?? [])];

  return {
    getSnapshot: (): MountDescriptionsSnapshot => ({
      manifest,
      runtime,
    }),
    setManifest: (entries): void => {
      manifest = sortManifest(entries);
    },
    addRuntime: (entry): void => {
      runtime = [...runtime.filter((candidate) => candidate.path !== entry.path), entry];
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
function renderBlock(
  tag: "mounted_connectors" | "runtime_mounted_connectors",
  entries: readonly MountDescription[],
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
): ModelRequest {
  const sections = [
    renderBlock("mounted_connectors", snapshot.manifest),
    renderBlock("runtime_mounted_connectors", snapshot.runtime),
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
      return next(injectMountDescriptions(config.state.getSnapshot(), request));
    },
    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      yield* next(injectMountDescriptions(config.state.getSnapshot(), request));
    },
    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },
  };
}
