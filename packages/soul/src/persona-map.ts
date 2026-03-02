/**
 * Creates and manages the per-channel persona map.
 *
 * Adapted from @koi/identity persona-map — uses async readBoundedFile
 * instead of sync readFileSync, and stores text instead of pre-built messages.
 */

import { resolve } from "node:path";
import { CHARS_PER_TOKEN, readBoundedFile, truncateToTokenBudget } from "@koi/file-resolution";
import type { ChannelPersonaConfig } from "./config.js";
import { DEFAULT_IDENTITY_MAX_TOKENS } from "./config.js";

/** A resolved persona with loaded instruction text and tracked file paths. */
export interface ResolvedPersona {
  readonly channelId: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly instructions: string;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

/** Result of creating the persona map, including aggregated warnings. */
export interface PersonaMapResult {
  readonly map: ReadonlyMap<string, CachedPersona>;
  readonly warnings: readonly string[];
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
 * If instructions is a `{ path }` object, reads from disk with bounded I/O.
 * If instructions is an inline string, truncates to the token budget.
 * Applies DEFAULT_IDENTITY_MAX_TOKENS unless overridden per-persona.
 */
export async function resolvePersonaContent(
  persona: ChannelPersonaConfig,
  basePath: string | undefined,
  maxTokens: number = DEFAULT_IDENTITY_MAX_TOKENS,
): Promise<ResolvedPersona> {
  const optionalFields = {
    ...(persona.name !== undefined ? { name: persona.name } : {}),
    ...(persona.avatar !== undefined ? { avatar: persona.avatar } : {}),
  };

  if (persona.instructions === undefined) {
    return {
      channelId: persona.channelId,
      ...optionalFields,
      instructions: "",
      sources: [],
      warnings: [],
    };
  }

  // Determine effective token budget: per-persona override > caller default
  const effectiveMaxTokens =
    typeof persona.instructions !== "string" && persona.instructions.maxTokens !== undefined
      ? persona.instructions.maxTokens
      : maxTokens;

  const label = `identity persona "${persona.channelId}"`;

  if (typeof persona.instructions === "string") {
    const { text, warning } = truncateToTokenBudget(
      persona.instructions,
      effectiveMaxTokens,
      label,
    );
    return {
      channelId: persona.channelId,
      ...optionalFields,
      instructions: text,
      sources: [],
      warnings: warning !== undefined ? [warning] : [],
    };
  }

  // { path: string; maxTokens?: number } — load from file with bounded I/O
  const filePath =
    basePath !== undefined
      ? resolve(basePath, persona.instructions.path)
      : resolve(persona.instructions.path);
  const maxChars = effectiveMaxTokens * CHARS_PER_TOKEN;
  const result = await readBoundedFile(filePath, maxChars);

  if (result === undefined) {
    return {
      channelId: persona.channelId,
      ...optionalFields,
      instructions: "",
      sources: [],
      warnings: [],
    };
  }

  const warnings: readonly string[] = result.truncated
    ? [
        `${label}: content truncated from ${String(result.originalSize)} chars to ${String(maxChars)} chars (~${String(effectiveMaxTokens)} tokens)`,
      ]
    : [];

  return {
    channelId: persona.channelId,
    ...optionalFields,
    instructions: result.content,
    sources: [filePath],
    warnings,
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
 * Returns the map along with aggregated warnings from all persona resolutions.
 */
export async function createPersonaMap(
  personas: readonly ChannelPersonaConfig[],
  basePath: string | undefined,
): Promise<PersonaMapResult> {
  const resolved = await Promise.all(personas.map((p) => resolvePersonaContent(p, basePath)));

  const allWarnings = resolved.flatMap((r) => [...r.warnings]);

  const map = new Map<string, CachedPersona>();
  for (const r of resolved) {
    const text = generatePersonaText(r);
    if (text === undefined) continue; // nothing to inject — skip

    map.set(r.channelId, { text, sources: r.sources });
  }
  return { map, warnings: allWarnings };
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
