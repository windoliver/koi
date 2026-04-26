import type { CapabilityProof, CapabilityToken } from "@koi/core";
import { signEd25519 } from "./ed25519.js";
import { signHmac } from "./hmac.js";

export type CapabilitySigner =
  | { readonly kind: "hmac-sha256"; readonly secret: Uint8Array }
  | {
      readonly kind: "ed25519";
      readonly privateKey: Uint8Array;
      readonly publicKeyFingerprint: string;
    };

export function buildProof(token: CapabilityToken, signer: CapabilitySigner): CapabilityProof {
  if (signer.kind === "hmac-sha256") {
    return { kind: "hmac-sha256", digest: signHmac(token, signer.secret) };
  }
  return {
    kind: "ed25519",
    publicKey: signer.publicKeyFingerprint,
    signature: signEd25519(token, signer.privateKey),
  };
}
