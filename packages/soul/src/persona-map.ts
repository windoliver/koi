/**
 * Creates and manages the per-channel persona map.
 *
 * Adapted from @koi/identity persona-map — uses async readBoundedFile
 * instead of sync readFileSync, and stores text instead of pre-built messages.
 */

import { resolve } from "node:path";
import { readBoundedFile } from "@koi/file-resolution";
import type { ChannelPersonaConfig } from "./config.js";

/** A resolved persona with loaded instruction text and tracked file paths. */
export interface ResolvedPersona {
  readonly channelId: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly instructions: string;
  readonly sources: readonly string[];
}

/** Cached per-channel persona entry. Stores text for O(1) lookup at call time. */
export interface CachedPersona {
  /** Persona text to be concatenated into the soul message. */
  readonly text: string;
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

  // { path: string } — load from file
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
 */
export function generatePersonaText(resolved: ResolvedPersona): string | undefined {
  const namePart =
    resolved.name !== undefined && resolved.name.length > 0
      ? `You are ${resolved.name}.`
      : undefined;
  const instrPart = resolved.instructions.length > 0 ? resolved.instructions : undefined;
  const parts = [namePart, instrPart].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Resolves all personas and creates the channelId => CachedPersona map.
 * Personas with no injectable content (no name, no instructions) are excluded.
 */
export async function createPersonaMap(
  personas: readonly ChannelPersonaConfig[],
  basePath: string | undefined,
): Promise<Map<string, CachedPersona>> {
  const resolved = await Promise.all(personas.map((p) => resolvePersonaContent(p, basePath)));

  const map = new Map<string, CachedPersona>();
  for (const r of resolved) {
    const text = generatePersonaText(r);
    if (text === undefined) continue; // nothing to inject — skip

    map.set(r.channelId, { text, sources: r.sources });
  }
  return map;
}

/**
 * Collects all tracked file paths from a persona map into a Set.
 */
export function createPersonaWatchedPaths(
  personaMap: ReadonlyMap<string, CachedPersona>,
): Set<string> {
  const paths = new Set<string>();
  for (const cached of personaMap.values()) {
    for (const s of cached.sources) {
      paths.add(s);
    }
  }
  return paths;
}
