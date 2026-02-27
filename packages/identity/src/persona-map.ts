/**
 * Builds and manages the per-channel persona map.
 */

import { resolve } from "node:path";
import type { InboundMessage } from "@koi/core/message";
import { readBoundedFile } from "@koi/file-resolution";
import type { ChannelPersonaConfig, CreateIdentityOptions } from "./config.js";

/** A resolved persona with loaded instruction text and tracked file paths. */
export interface ResolvedPersona {
  readonly channelId: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly instructions: string;
  readonly sources: readonly string[];
}

/** Cached per-channel persona entry. Pre-built system message for O(1) lookup. */
export interface CachedPersona {
  /** Pre-built system message injected at the start of every model call for this channel. */
  readonly message: InboundMessage;
  /** File paths tracked for auto-reload on fs_write. */
  readonly sources: readonly string[];
}

/**
 * Resolves instruction content for a single persona config entry.
 * If instructions is a `{ path }` object, reads from disk asynchronously.
 * If instructions is an inline string, uses it directly.
 */
export async function resolvePersonaContent(
  persona: ChannelPersonaConfig,
  basePath: string | undefined,
): Promise<ResolvedPersona> {
  const optionalFields = {
    ...(persona.name !== undefined ? { name: persona.name } : {}),
    ...(persona.avatar !== undefined ? { avatar: persona.avatar } : {}),
  };

  if (persona.instructions === undefined) {
    return { channelId: persona.channelId, ...optionalFields, instructions: "", sources: [] };
  }

  if (typeof persona.instructions === "string") {
    return {
      channelId: persona.channelId,
      ...optionalFields,
      instructions: persona.instructions,
      sources: [],
    };
  }

  // { path: string } — load from file asynchronously
  const filePath =
    basePath !== undefined
      ? resolve(basePath, persona.instructions.path)
      : resolve(persona.instructions.path);
  const content = await readBoundedFile(filePath);
  return {
    channelId: persona.channelId,
    ...optionalFields,
    instructions: content ?? "",
    sources: content !== undefined ? [filePath] : [],
  };
}

/**
 * Generates the persona text from a resolved persona.
 * Returns undefined when nothing meaningful to inject (no name, no instructions).
 *
 * Note: `avatar` is intentionally excluded — it is display metadata for the channel
 * UI layer, not LLM-visible content. Channel adapters may surface it independently.
 */
function generatePersonaText(resolved: ResolvedPersona): string | undefined {
  const parts: string[] = [];
  if (resolved.name !== undefined && resolved.name.length > 0) {
    parts.push(`You are ${resolved.name}.`);
  }
  if (resolved.instructions.length > 0) {
    parts.push(resolved.instructions);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Builds the InboundMessage for a resolved persona.
 * Returns undefined when there is nothing to inject.
 */
function buildPersonaMessage(resolved: ResolvedPersona): InboundMessage | undefined {
  const text = generatePersonaText(resolved);
  if (text === undefined) return undefined;

  return {
    senderId: "system:identity",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

/**
 * Resolves all personas in parallel and builds the channelId → CachedPersona map.
 * Personas with no injectable content (no name, no instructions) are excluded.
 */
export async function buildPersonaMap(
  options: CreateIdentityOptions,
): Promise<Map<string, CachedPersona>> {
  const resolved = await Promise.all(
    options.personas.map((p) => resolvePersonaContent(p, options.basePath)),
  );

  const map = new Map<string, CachedPersona>();
  for (const r of resolved) {
    const message = buildPersonaMessage(r);
    if (message === undefined) continue; // nothing to inject — skip

    map.set(r.channelId, { message, sources: r.sources });
  }
  return map;
}

/**
 * Collects all tracked file paths from a persona map into a Set.
 */
export function buildWatchedPaths(personaMap: ReadonlyMap<string, CachedPersona>): Set<string> {
  const paths = new Set<string>();
  for (const cached of personaMap.values()) {
    for (const s of cached.sources) {
      paths.add(s);
    }
  }
  return paths;
}
