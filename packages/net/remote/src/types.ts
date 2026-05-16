export type RemoteJwtRejectReason =
  | "malformed"
  | "unsupported_alg"
  | "invalid_signature"
  | "expired"
  | "not_before"
  | "invalid_issuer"
  | "invalid_audience"
  | "missing_subject"
  | "missing_device";

export interface RemoteJwtClaims {
  readonly subject: string;
  readonly deviceId: string;
  readonly agentId?: string | undefined;
  readonly permissions: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RemoteJwtVerifierOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowMs?: () => number;
  readonly clockSkewSeconds?: number;
}

export type RemoteJwtVerifyResult =
  | { readonly ok: true; readonly claims: RemoteJwtClaims }
  | { readonly ok: false; readonly reason: RemoteJwtRejectReason };
