import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import type { CapabilityToken } from "@koi/core";
import { serializeForSigning } from "./canonical.js";

export function signEd25519(token: CapabilityToken, privateKeyDer: Uint8Array): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyDer), format: "der", type: "pkcs8" });
  const payload = serializeForSigning(token);
  const sig = sign(null, payload, key);
  return sig.toString("base64");
}

export function verifyEd25519(
  token: CapabilityToken,
  publicKeys: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (token.proof.kind !== "ed25519") return false;
  const pubDer = publicKeys.get(token.proof.publicKey);
  if (!pubDer) return false;

  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(pubDer), format: "der", type: "spki" });
  } catch {
    return false;
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(token.proof.signature, "base64"));
  } catch {
    return false;
  }

  return verify(null, serializeForSigning(token), key, sigBytes);
}
