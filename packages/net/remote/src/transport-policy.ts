export type RemoteTransportKind = "websocket" | "http-post";

export type RemoteOperationKind = "read" | "stream" | "write";

export interface RemoteTransportPolicyInput {
  readonly transport: RemoteTransportKind;
  readonly operation: RemoteOperationKind;
  readonly url: string;
  readonly allowInsecureLocalhost?: boolean | undefined;
}

export type RemoteTransportPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "wrong_transport" | "insecure_transport" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function enforceRemoteTransportPolicy(
  input: RemoteTransportPolicyInput,
): RemoteTransportPolicyResult {
  const transport = parseTransport(input.transport);
  const operation = parseOperation(input.operation);
  if (
    transport === undefined ||
    operation === undefined ||
    !isOperationAllowedOnTransport(transport, operation)
  ) {
    return { ok: false, reason: "wrong_transport" };
  }

  if (!isSecureTransportUrl(transport, input.url, input.allowInsecureLocalhost === true)) {
    return { ok: false, reason: "insecure_transport" };
  }

  return { ok: true };
}

function isOperationAllowedOnTransport(
  transport: RemoteTransportKind,
  operation: RemoteOperationKind,
): boolean {
  if (transport === "websocket") return operation === "read" || operation === "stream";
  return operation === "write";
}

function parseTransport(value: string): RemoteTransportKind | undefined {
  if (value === "websocket" || value === "http-post") return value;
  return undefined;
}

function parseOperation(value: string): RemoteOperationKind | undefined {
  if (value === "read" || value === "stream" || value === "write") return value;
  return undefined;
}

function isSecureTransportUrl(
  transport: RemoteTransportKind,
  url: string,
  allowInsecureLocalhost: boolean,
): boolean {
  try {
    const parsed = new URL(url);
    if (!isSchemeAllowedForTransport(transport, parsed.protocol)) return false;
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
    return allowInsecureLocalhost && LOOPBACK_HOSTS.has(normalizeHostname(parsed.hostname));
  } catch {
    return false;
  }
}

function isSchemeAllowedForTransport(transport: RemoteTransportKind, protocol: string): boolean {
  if (transport === "websocket") return protocol === "ws:" || protocol === "wss:";
  return protocol === "http:" || protocol === "https:";
}

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}
