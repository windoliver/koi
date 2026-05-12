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
 * Compute a short fingerprint over the (image, image-id, profile) triple used
 * to create a persistent sandbox. Stored as the `koi.sandbox.profile-hash`
 * label so a later `findOrCreate` can detect drift before reattaching to a
 * container that no longer matches the requested policy.
 *
 * The optional `imageId` argument carries Docker's immutable content-addressed
 * image ID (e.g. `sha256:abc...`). Including it covers the mutable-tag case
 * (`my-image:latest` repointed at new content): the recomputed fingerprint
 * differs from the stored one, so reuse fails closed instead of silently
 * attaching to a container running the old root filesystem. When `imageId` is
 * undefined (image not resolvable, or client doesn't expose `resolveImageId`),
 * the fingerprint degrades to (image-string, profile) only.
 *
 * Truncated to 16 hex chars (64 bits) — collision probability for
 * sub-thousand sandboxes per scope is negligible while keeping the docker
 * label value short.
 */
export function computeProfileFingerprint(
  profile: SandboxProfile,
  image: string,
  imageId?: string,
): string {
  const payload = canonicalJson({ image, imageId: imageId ?? null, profile });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
