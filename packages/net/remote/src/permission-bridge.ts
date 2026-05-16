import type { PermissionQuery } from "@koi/core";

export interface RemotePermissionMapping {
  readonly remote: string;
  readonly action: string;
  readonly resource?: string | undefined;
}

export type RemotePermissionMapResult =
  | { readonly ok: true; readonly queries: readonly PermissionQuery[] }
  | {
      readonly ok: false;
      readonly reason: "unknown_permission";
      readonly permission: string;
    };

export function mapRemotePermissions(
  claims: readonly string[],
  mappings: readonly RemotePermissionMapping[],
): RemotePermissionMapResult {
  const mappingByRemote = new Map(mappings.map((mapping) => [mapping.remote, mapping]));
  const queries: PermissionQuery[] = [];

  for (const claim of claims) {
    const mapping = mappingByRemote.get(claim);
    if (mapping === undefined) {
      return { ok: false, reason: "unknown_permission", permission: claim };
    }
    queries.push({
      principal: "remote",
      action: mapping.action,
      resource: mapping.resource ?? "*",
      context: { remotePermission: claim },
    });
  }

  return { ok: true, queries };
}
