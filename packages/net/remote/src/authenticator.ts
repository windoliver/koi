import type { PermissionQuery } from "@koi/core";
import { verifyRemoteJwt } from "./jwt.js";
import { mapRemotePermissions, type RemotePermissionMapping } from "./permission-bridge.js";
import {
  enforceRemoteTransportPolicy,
  type RemoteOperationKind,
  type RemoteTransportKind,
} from "./transport-policy.js";
import type { TrustedDeviceRegistry } from "./trusted-device.js";
import type { RemoteJwtVerifierOptions } from "./types.js";

export type RemoteAuthRejectReason =
  | "jwt_rejected"
  | "untrusted_device"
  | "permission_rejected"
  | "transport_rejected";

export interface RemoteAuthRequest {
  readonly bearerToken: string;
  readonly transport: RemoteTransportKind;
  readonly operation: RemoteOperationKind;
  readonly url: string;
}

export interface RemoteAuthenticatorOptions {
  readonly jwt: RemoteJwtVerifierOptions;
  readonly trustedDevices: TrustedDeviceRegistry;
  readonly permissionMappings: readonly RemotePermissionMapping[];
  readonly allowInsecureLocalhost?: boolean | undefined;
}

export type RemoteAuthResult =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly deviceId: string;
      readonly permissions: readonly PermissionQuery[];
    }
  | { readonly ok: false; readonly reason: RemoteAuthRejectReason };

export async function authenticateRemoteRequest(
  request: RemoteAuthRequest,
  options: RemoteAuthenticatorOptions,
): Promise<RemoteAuthResult> {
  const jwt = await verifyRemoteJwt(stripBearerPrefix(request.bearerToken), options.jwt);
  if (!jwt.ok) return { ok: false, reason: "jwt_rejected" };

  if (!options.trustedDevices.isTrusted(jwt.claims.subject, jwt.claims.deviceId)) {
    return { ok: false, reason: "untrusted_device" };
  }

  const permissions = mapRemotePermissions(jwt.claims.permissions, options.permissionMappings);
  if (!permissions.ok) return { ok: false, reason: "permission_rejected" };

  const transport = enforceRemoteTransportPolicy({
    transport: request.transport,
    operation: request.operation,
    url: request.url,
    allowInsecureLocalhost: options.allowInsecureLocalhost,
  });
  if (!transport.ok) return { ok: false, reason: "transport_rejected" };

  return {
    ok: true,
    subject: jwt.claims.subject,
    deviceId: jwt.claims.deviceId,
    permissions: permissions.queries,
  };
}

function stripBearerPrefix(value: string): string {
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
}
