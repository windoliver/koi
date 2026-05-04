/**
 * JSON I/O helpers over a NexusTransport.
 *
 * Single-file utilities used by the snapshot store. Each helper returns
 * `Result<T, KoiError>` so callers can compose without throwing.
 *
 * `readJson` treats NOT_FOUND / EXTERNAL "file does not exist" responses as
 * `value: undefined` rather than errors — matches the chain-store contract,
 * where reading a missing meta is "empty chain", not a failure.
 */

import type { KoiError, Result } from "@koi/core";
import { internal } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface NexusListEntry {
  readonly is_directory?: boolean;
  readonly path: string;
}

interface NexusListResponse {
  readonly files: readonly NexusListEntry[];
}

interface NexusReadResponse {
  readonly content?: unknown;
  readonly metadata?: { readonly size?: number };
}

/** Decode a Nexus read result into a UTF-8 string. */
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

/**
 * Convert a glob pattern to a RegExp.
 * Supports `*` (any char except `/`) and `**` (any char including `/`).
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Extract the non-glob directory prefix from a glob pattern.
 * Stops at the first path segment that contains a glob character (*, ?, [).
 * For example, snapshots-slash-star-slash-node.json returns snapshots.
 */
function patternDir(pattern: string): string {
  const parts = pattern.split("/");
  const nonGlob: string[] = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[")) break;
    nonGlob.push(part);
  }
  // If no non-glob parts, list root
  if (nonGlob.length === 0) return "/";
  // If the first part is empty (absolute path like /foo/bar), preserve leading /
  const joined = nonGlob.join("/");
  return joined === "" ? "/" : joined;
}

/** Read + JSON-parse a file. Missing file → `value: undefined`. */
export async function readJson<T>(
  transport: NexusTransport,
  path: string,
): Promise<Result<T | undefined, KoiError>> {
  const r = await transport.call<NexusReadResponse | string>("read", { path });
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
      return { ok: true, value: undefined };
    }
    return r;
  }
  const text = decodeContent(r.value);
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: internal(`json-io: parse error at ${path}`, e) };
  }
}

/** Stringify + write a value to a path. */
export async function writeJson(
  transport: NexusTransport,
  path: string,
  data: unknown,
): Promise<Result<void, KoiError>> {
  const r = await transport.call<unknown>("write", {
    path,
    content: JSON.stringify(data),
  });
  if (!r.ok) return r;
  return { ok: true, value: undefined };
}

/** Delete a file. Missing file is a no-op (returns `ok: true`). */
export async function deleteJson(
  transport: NexusTransport,
  path: string,
): Promise<Result<void, KoiError>> {
  const r = await transport.call<unknown>("delete", { path });
  if (!r.ok && r.error.code !== "NOT_FOUND" && r.error.code !== "EXTERNAL") return r;
  return { ok: true, value: undefined };
}

/** Existence check — true when the path can be read. */
export async function exists(
  transport: NexusTransport,
  path: string,
): Promise<Result<boolean, KoiError>> {
  const r = await transport.call<unknown>("read", { path });
  if (r.ok) return { ok: true, value: true };
  if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
    return { ok: true, value: false };
  }
  return { ok: false, error: r.error };
}

/**
 * Glob list — returns file paths matching the pattern.
 *
 * Lists the parent directory recursively and filters client-side using the
 * glob pattern. This matches how the Nexus filesystem backend handles search
 * (recursive list + client-side filter) and works with both the fake transport
 * and the production Nexus server.
 */
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
