import { createHash } from "node:crypto";
import type { SandboxProfile } from "@koi/core";

/**
 * Deterministic JSON encoding: sort object keys recursively. Distinct property
 * orders that semantically match must produce the same string so the resulting
 * hash is stable across writes/reads.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Compute a short fingerprint over the (image, profile) pair used to create a
 * persistent sandbox. Stored as the `koi.sandbox.profile-hash` label so a
 * later `findOrCreate` can detect profile drift before reattaching to a
 * container that no longer matches the requested policy.
 *
 * Truncated to 16 hex chars (64 bits) — collision probability for
 * sub-thousand sandboxes per scope is negligible while keeping the docker
 * label value short.
 */
export function computeProfileFingerprint(profile: SandboxProfile, image: string): string {
  const payload = canonicalJson({ image, profile });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
