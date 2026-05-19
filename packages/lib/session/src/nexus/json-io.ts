import type { KoiError, Result } from "@koi/core";
import { internal } from "@koi/core";
import { extractReadContent, type NexusTransport } from "@koi/nexus-client";

interface NexusListEntry {
  readonly is_directory?: boolean;
  readonly path: string;
}

interface NexusListResponse {
  readonly files: readonly NexusListEntry[];
  readonly has_more?: boolean | undefined;
}

export async function readText(
  transport: NexusTransport,
  path: string,
): Promise<Result<string | undefined, KoiError>> {
  const result = await transport.call<unknown>("read", { path });
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") return { ok: true, value: undefined };
    return result;
  }
  const extracted = extractReadContent(result.value);
  if (!extracted.ok) return extracted;
  return extracted;
}

export async function writeText(
  transport: NexusTransport,
  path: string,
  content: string,
): Promise<Result<void, KoiError>> {
  const result = await transport.call<unknown>("write", { path, content });
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

export async function deletePath(
  transport: NexusTransport,
  path: string,
): Promise<Result<void, KoiError>> {
  const result = await transport.call<unknown>("delete", { path });
  if (!result.ok && result.error.code !== "NOT_FOUND") return result;
  return { ok: true, value: undefined };
}

export async function readJson<T>(
  transport: NexusTransport,
  path: string,
): Promise<Result<T | undefined, KoiError>> {
  const text = await readText(transport, path);
  if (!text.ok) return text;
  if (text.value === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text.value) as T };
  } catch (error: unknown) {
    return { ok: false, error: internal(`nexus session JSON parse failed at ${path}`, error) };
  }
}

export async function writeJson(
  transport: NexusTransport,
  path: string,
  value: unknown,
): Promise<Result<void, KoiError>> {
  return writeText(transport, path, JSON.stringify(value));
}

export async function listFilePaths(
  transport: NexusTransport,
  path: string,
): Promise<Result<readonly string[], KoiError>> {
  const result = await transport.call<NexusListResponse>("list", { path, recursive: true });
  if (!result.ok) return result;
  if (result.value.has_more === true) {
    return {
      ok: false,
      error: internal(`nexus session list truncated at ${path}`),
    };
  }
  return {
    ok: true,
    value: result.value.files
      .filter((entry) => entry.is_directory !== true)
      .map((entry) => entry.path),
  };
}
