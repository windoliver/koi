import type { RemoteJwtClaims, RemoteJwtVerifierOptions, RemoteJwtVerifyResult } from "./types.js";

const SECOND_MS = 1_000;

interface ParsedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

export async function verifyRemoteJwt(
  token: string,
  options: RemoteJwtVerifierOptions,
): Promise<RemoteJwtVerifyResult> {
  const parsed = parseJwt(token);
  if (parsed === undefined) return { ok: false, reason: "malformed" };

  if (parsed.header.alg !== "HS256") {
    return { ok: false, reason: "unsupported_alg" };
  }

  const signatureValid = await verifyHs256(options.secret, parsed.signingInput, parsed.signature);
  if (!signatureValid) return { ok: false, reason: "invalid_signature" };

  const claimError = validateRegisteredClaims(parsed.payload, options);
  if (claimError !== undefined) return { ok: false, reason: claimError };

  const subject = parsed.payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    return { ok: false, reason: "missing_subject" };
  }

  const deviceId = parsed.payload.device_id;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    return { ok: false, reason: "missing_device" };
  }

  const permissions = parsePermissions(parsed.payload.permissions);
  if (permissions === undefined) return { ok: false, reason: "invalid_permissions" };

  return {
    ok: true,
    claims: mapClaims(parsed.payload, subject, deviceId, permissions),
  };
}

function parseJwt(token: string): ParsedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedHeader.length === 0 ||
    encodedPayload === undefined ||
    encodedPayload.length === 0 ||
    encodedSignature === undefined
  ) {
    return undefined;
  }

  const header = parseJsonObject(encodedHeader);
  const payload = parseJsonObject(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (header === undefined || payload === undefined || signature === undefined) {
    return undefined;
  }

  return {
    header,
    payload,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature,
  };
}

function parseJsonObject(encoded: string): Record<string, unknown> | undefined {
  const decoded = decodeBase64Url(encoded);
  if (decoded === undefined) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(decoded)) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(encoded: string): Uint8Array | undefined {
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function verifyHs256(
  secret: string,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const encodedSecret = new TextEncoder().encode(secret);
  if (encodedSecret.byteLength === 0) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encodedSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signature.slice().buffer,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return false;
  }
}

function validateRegisteredClaims(
  payload: Record<string, unknown>,
  options: RemoteJwtVerifierOptions,
): Exclude<RemoteJwtVerifyResult, { readonly ok: true }>["reason"] | undefined {
  if (payload.iss !== options.issuer) return "invalid_issuer";
  if (payload.aud !== options.audience) return "invalid_audience";

  const nowSeconds = Math.floor((options.nowMs?.() ?? Date.now()) / SECOND_MS);
  const skew = options.clockSkewSeconds ?? 0;
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || nowSeconds - skew >= exp) {
    return "expired";
  }
  const nbf = payload.nbf;
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf))) {
    return "not_before";
  }
  if (typeof nbf === "number" && nowSeconds + skew < nbf) {
    return "not_before";
  }
  return undefined;
}

function mapClaims(
  payload: Record<string, unknown>,
  subject: string,
  deviceId: string,
  permissions: readonly string[],
): RemoteJwtClaims {
  const metadata =
    payload.metadata !== null &&
    typeof payload.metadata === "object" &&
    !Array.isArray(payload.metadata)
      ? { ...(payload.metadata as Record<string, unknown>) }
      : {};
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  return {
    subject,
    deviceId,
    ...(agentId !== undefined ? { agentId } : {}),
    permissions,
    metadata,
  };
}

function parsePermissions(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((permission) => typeof permission === "string") ? value : undefined;
}
