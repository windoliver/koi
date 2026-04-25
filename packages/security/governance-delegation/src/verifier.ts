import type {
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  ScopeChecker,
  VerifyContext,
} from "@koi/core";
import { verifyEd25519 } from "./ed25519.js";
import { verifyHmac } from "./hmac.js";
import type { CapabilityRevocationRegistry } from "./revocation.js";

export interface CapabilityVerifierOptions {
  readonly hmac?: { readonly secret: Uint8Array };
  readonly ed25519?: { readonly publicKeys: ReadonlyMap<string, Uint8Array> };
  readonly scopeChecker: ScopeChecker;
  readonly revocations?: CapabilityRevocationRegistry;
}

function deny(reason: CapabilityVerifyResult & { readonly ok: false }): CapabilityVerifyResult {
  return reason;
}

export function createCapabilityVerifier(opts: CapabilityVerifierOptions): CapabilityVerifier {
  return {
    async verify(token: CapabilityToken, ctx: VerifyContext): Promise<CapabilityVerifyResult> {
      // 1. Signature dispatch
      if (token.proof.kind === "hmac-sha256") {
        if (!opts.hmac) return deny({ ok: false, reason: "proof_type_unsupported" });
        if (!verifyHmac(token, opts.hmac.secret)) {
          return deny({ ok: false, reason: "invalid_signature" });
        }
      } else if (token.proof.kind === "ed25519") {
        if (!opts.ed25519) return deny({ ok: false, reason: "proof_type_unsupported" });
        if (!verifyEd25519(token, opts.ed25519.publicKeys)) {
          return deny({ ok: false, reason: "invalid_signature" });
        }
      } else {
        return deny({ ok: false, reason: "proof_type_unsupported" });
      }

      // 2. Clock-skew (now < createdAt → tampered)
      if (ctx.now < token.createdAt) {
        return deny({ ok: false, reason: "invalid_signature" });
      }
      // 3. Expiry
      if (ctx.now >= token.expiresAt) {
        return deny({ ok: false, reason: "expired" });
      }
      // 4. Session
      if (!ctx.activeSessionIds.has(token.scope.sessionId)) {
        return deny({ ok: false, reason: "session_invalid" });
      }
      // 5. Revocation
      if (opts.revocations && (await opts.revocations.isRevoked(token.id))) {
        return deny({ ok: false, reason: "revoked" });
      }
      // 6. Scope
      const allowed = await opts.scopeChecker.isAllowed(ctx.toolId, {
        permissions: token.scope.permissions,
        ...(token.scope.resources ? { resources: token.scope.resources } : {}),
        sessionId: token.scope.sessionId,
      });
      if (!allowed) {
        return deny({ ok: false, reason: "scope_exceeded" });
      }
      return { ok: true, token };
    },
  };
}
