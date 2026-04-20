/**
 * Boundary-level input validation for saveArtifact. Per CLAUDE.md: all
 * external input validated at the system boundary.
 */

import type { ArtifactError, SaveArtifactInput } from "./types.js";

const MAX_NAME_LEN = 255;
const MAX_MIME_LEN = 128;
const MAX_TAG_LEN = 64;
const MAX_TAGS = 32;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

function hasForbiddenNameChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    // Forbidden: null byte (0x00), forward slash, backslash
    if (c === 0 || c === 0x2f || c === 0x5c) return true;
  }
  return false;
}

export function validateSaveInput(
  input: SaveArtifactInput,
  maxArtifactBytes: number,
): ArtifactError | undefined {
  if (input.name.length === 0) {
    return {
      kind: "invalid_input",
      field: "name",
      reason: "must not be empty",
    };
  }
  if (input.name.length > MAX_NAME_LEN) {
    return {
      kind: "invalid_input",
      field: "name",
      reason: `exceeds ${MAX_NAME_LEN} chars`,
    };
  }
  if (hasForbiddenNameChar(input.name)) {
    return {
      kind: "invalid_input",
      field: "name",
      reason: "contains forbidden characters (null byte, slash, backslash)",
    };
  }
  if (input.mimeType.length === 0 || input.mimeType.length > MAX_MIME_LEN) {
    return {
      kind: "invalid_input",
      field: "mimeType",
      reason: `length must be in [1, ${MAX_MIME_LEN}]`,
    };
  }
  if (!MIME_RE.test(input.mimeType)) {
    return {
      kind: "invalid_input",
      field: "mimeType",
      reason: "must match type/subtype pattern",
    };
  }
  if (input.data.byteLength > maxArtifactBytes) {
    return {
      kind: "invalid_input",
      field: "data",
      reason: `exceeds maxArtifactBytes (${maxArtifactBytes})`,
    };
  }
  if (input.tags) {
    if (input.tags.length > MAX_TAGS) {
      return {
        kind: "invalid_input",
        field: "tags",
        reason: `exceeds ${MAX_TAGS} tags`,
      };
    }
    for (const tag of input.tags) {
      if (tag.length === 0 || tag.length > MAX_TAG_LEN) {
        return {
          kind: "invalid_input",
          field: "tags",
          reason: `tag length must be in [1, ${MAX_TAG_LEN}]`,
        };
      }
    }
  }
  return undefined;
}
