import type { ExtensionStorage } from "./storage.js";

const PRIVATE_SUFFIXES = [".local", ".internal", ".corp", ".home.arpa"] as const;

function isIpv4Private(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255))
    return false;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return false;
}

function isIpv6Private(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

export function normalizeOrigin(input: string): string {
  return new URL(input).origin;
}

export function isPrivateOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (hostname.includes(":")) return isIpv6Private(hostname);
  return isIpv4Private(hostname);
}

export async function isOriginAllowedByPolicy(
  storage: ExtensionStorage,
  origin: string,
): Promise<boolean> {
  if (!isPrivateOrigin(origin)) return true;
  const allowlist = await storage.getPrivateOriginAllowlist();
  return allowlist.includes(origin);
}
