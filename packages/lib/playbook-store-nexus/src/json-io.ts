/**
 * JSON I/O helpers for the Nexus-backed ACE stores.
 *
 * `sanitizeId` collapses colons to underscores so session IDs like
 * "session:2026-05-03:abc" are storable as filenames Nexus can list/glob.
 *
 * `listChildren` lists the non-glob prefix of the pattern recursively and
 * filters client-side, matching how `@koi/fs-nexus` implements search. This
 * is required because the Nexus `list` RPC accepts `{ path, recursive }`,
 * not a glob `pattern`.
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

export function sanitizeId(id: string): string {
  return id.replace(/:/g, "_");
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
    if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
      return { ok: true, value: false };
    }
    return r;
  }
  return { ok: true, value: true };
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
