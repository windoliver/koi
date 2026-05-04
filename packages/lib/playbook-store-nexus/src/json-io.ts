/**
 * JSON I/O helpers for the Nexus-backed ACE stores.
 *
 * `validateAceId` rejects IDs that would escape the basePath sandbox.
 * `encodeAceId` / `decodeAceId` provide a reversible, path-safe encoding so
 * that distinct IDs always map to distinct filenames (no collision between
 * "a:b" and "a_b").
 *
 * Encoding rules:
 *   `_` → `_5F`  (escape character itself, so round-trip is unambiguous)
 *   `:` → `_3A`  (colons are common in session IDs)
 *
 * All other ASCII-printable characters that are valid in filenames are kept
 * as-is. Characters that are never allowed in ACE IDs (/, \, \0, \n, \r, ..)
 * are rejected by `validateAceId` before encoding runs.
 *
 * `listChildren` lists the non-glob prefix of the pattern recursively and
 * filters client-side, matching how `@koi/fs-nexus` implements search. This
 * is required because the Nexus `list` RPC accepts `{ path, recursive }`,
 * not a glob `pattern`.
 */

import type { KoiError, Result } from "@koi/core";
import { internal, validation } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface NexusListEntry {
  readonly is_directory?: boolean;
  readonly path: string;
}

interface NexusListResponse {
  readonly files: readonly NexusListEntry[];
}

/**
 * Reject ACE IDs that would escape the basePath sandbox, cause filename
 * collisions, or inject glob metacharacters into list/search patterns.
 *
 * Rejected characters:
 *   empty, '/', '..', '\', '\0', '\n', '\r'  — path-traversal / sandbox-escape
 *   '*', '?', '[', ']'                        — glob metacharacters that would
 *                                               corrupt listChildren patterns
 */
export function validateAceId(id: string, label: string): Result<void, KoiError> {
  if (id.length === 0) return { ok: false, error: validation(`${label} cannot be empty`) };
  if (id.includes("/"))
    return { ok: false, error: validation(`${label} cannot contain '/': ${id}`) };
  if (id === ".." || id.includes("/..") || id.startsWith("../")) {
    return { ok: false, error: validation(`${label} cannot be '..': ${id}`) };
  }
  if (id.includes("..")) {
    // Catch embedded ".." anywhere
    return { ok: false, error: validation(`${label} cannot contain '..': ${id}`) };
  }
  if (id.includes("\\"))
    return { ok: false, error: validation(`${label} cannot contain '\\': ${id}`) };
  if (id.includes("\0"))
    return { ok: false, error: validation(`${label} cannot contain null bytes`) };
  if (id.includes("\n"))
    return { ok: false, error: validation(`${label} cannot contain newlines`) };
  if (id.includes("\r"))
    return { ok: false, error: validation(`${label} cannot contain carriage returns`) };
  // Glob metacharacters: reject to prevent ID injection into listChildren patterns.
  if (id.includes("*"))
    return { ok: false, error: validation(`${label} cannot contain '*': ${id}`) };
  if (id.includes("?"))
    return { ok: false, error: validation(`${label} cannot contain '?': ${id}`) };
  if (id.includes("["))
    return { ok: false, error: validation(`${label} cannot contain '[': ${id}`) };
  if (id.includes("]"))
    return { ok: false, error: validation(`${label} cannot contain ']': ${id}`) };
  return { ok: true, value: undefined };
}

/**
 * Reversible, path-safe encoding for ACE IDs.
 * `_` → `_5F`, `:` → `_3A`
 * This ensures distinct IDs always produce distinct filenames.
 */
export function encodeAceId(id: string): string {
  return id.replace(/_/g, "_5F").replace(/:/g, "_3A");
}

/**
 * Inverse of `encodeAceId`. Reconstructs the original ID from a filename stem.
 */
export function decodeAceId(encoded: string): string {
  return encoded.replace(/_3A/g, ":").replace(/_5F/g, "_");
}

export function basenameNoExt(path: string): string {
  const file = path.split("/").pop() ?? "";
  return file.replace(/\.json$/, "");
}

function decodeContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return "";
  const obj = raw as Record<string, unknown>;
  if (obj.__type__ === "bytes" && typeof obj.data === "string") {
    return Buffer.from(obj.data, "base64").toString("utf-8");
  }
  if (obj.content !== undefined) return decodeContent(obj.content);
  return "";
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function patternDir(pattern: string): string {
  const parts = pattern.split("/");
  const nonGlob: string[] = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[")) break;
    nonGlob.push(part);
  }
  if (nonGlob.length === 0) return "/";
  const joined = nonGlob.join("/");
  return joined === "" ? "/" : joined;
}

export async function readJson<T>(
  transport: NexusTransport,
  path: string,
): Promise<Result<T | undefined, KoiError>> {
  const r = await transport.call<unknown>("read", { path });
  if (!r.ok) {
    // Only NOT_FOUND means "absent". EXTERNAL means a degraded backend — propagate.
    if (r.error.code === "NOT_FOUND") {
      return { ok: true, value: undefined };
    }
    return r;
  }
  const text = decodeContent(r.value);
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: internal(`playbook-store-nexus: parse error at ${path}`, e) };
  }
}

export async function writeJson(
  transport: NexusTransport,
  path: string,
  data: unknown,
): Promise<Result<void, KoiError>> {
  const r = await transport.call<unknown>("write", { path, content: JSON.stringify(data) });
  if (!r.ok) return r;
  return { ok: true, value: undefined };
}

export async function deleteJson(
  transport: NexusTransport,
  path: string,
): Promise<Result<boolean, KoiError>> {
  const r = await transport.call<unknown>("delete", { path });
  if (!r.ok) {
    // Only NOT_FOUND is a no-op (file already absent). EXTERNAL propagates.
    if (r.error.code === "NOT_FOUND") {
      return { ok: true, value: false };
    }
    return r;
  }
  return { ok: true, value: true };
}

/** Existence check — true when the path can be read. */
export async function exists(
  transport: NexusTransport,
  path: string,
): Promise<Result<boolean, KoiError>> {
  const r = await transport.call<unknown>("read", { path });
  if (r.ok) return { ok: true, value: true };
  // Only NOT_FOUND means absent. EXTERNAL propagates.
  if (r.error.code === "NOT_FOUND") {
    return { ok: true, value: false };
  }
  return { ok: false, error: r.error };
}

export async function listChildren(
  transport: NexusTransport,
  pattern: string,
): Promise<Result<readonly string[], KoiError>> {
  const dir = patternDir(pattern);
  const regex = globToRegex(pattern);
  const r = await transport.call<NexusListResponse>("list", {
    path: dir,
    recursive: true,
  });
  if (!r.ok) return r;
  const paths = r.value.files
    .filter((f) => f.is_directory !== true && regex.test(f.path))
    .map((f) => f.path);
  return { ok: true, value: paths };
}
