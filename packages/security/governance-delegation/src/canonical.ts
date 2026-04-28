import type { CapabilityToken } from "@koi/core";

const TEXT_ENCODER = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v !== undefined) {
        sorted[key] = canonicalize(v);
      }
    }
    return sorted;
  }
  return value;
}

export function serializeForSigning(token: CapabilityToken): Uint8Array {
  // Strip proof: it's the field being produced/verified.
  const { proof: _proof, ...rest } = token;
  void _proof;
  const json = JSON.stringify(canonicalize(rest));
  return TEXT_ENCODER.encode(json);
}
