/**
 * NexusPath — branded string type for Nexus namespace paths.
 *
 * Represents a path within the unified Nexus storage namespace.
 * Convention: forward-slash separated, no `..`, no leading `/`, max 512 chars.
 *
 * Examples:
 *   agents/{agentId}/bricks/{brickId}.json
 *   agents/{agentId}/events/{streamId}/events/0000000001.json
 *   groups/{groupId}/scratch/{path}
 *
 * Exception: branded type constructors (identity casts) are permitted in L0
 * as zero-logic operations for type safety.
 */

declare const __nexusPathBrand: unique symbol;

/**
 * Branded string type for Nexus namespace paths.
 * Must not contain `..`, must not start with `/`, max 512 characters.
 */
export type NexusPath = string & { readonly [__nexusPathBrand]: "NexusPath" };

/** Create a branded NexusPath from a plain string. */
export function nexusPath(raw: string): NexusPath {
  return raw as NexusPath;
}

/** Maximum length for a NexusPath. */
export const MAX_NEXUS_PATH_LENGTH = 512;
